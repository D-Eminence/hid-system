// Package testrepo builds disposable TUF repositories for attack tests.
// It must never be used to provision staging or production signing keys.
package testrepo

import (
	"crypto"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/sigstore/sigstore/pkg/signature"
	"github.com/theupdateframework/go-tuf/v2/metadata"
)

type Options struct {
	Now              time.Time
	RootExpires      time.Time
	TargetsExpires   time.Time
	SnapshotExpires  time.Time
	TimestampExpires time.Time
}

type Repository struct {
	PublicDir   string
	MetadataDir string
	TargetsDir  string
	Root        []byte
	TargetPath  string
	TargetData  []byte

	root      *metadata.Metadata[metadata.RootType]
	targets   *metadata.Metadata[metadata.TargetsType]
	snapshot  *metadata.Metadata[metadata.SnapshotType]
	timestamp *metadata.Metadata[metadata.TimestampType]
	keys      map[string]*ecdsa.PrivateKey
}

func New(t testing.TB, targetPath string, targetData []byte, options Options) *Repository {
	t.Helper()
	now := options.Now.UTC()
	if now.IsZero() {
		now = time.Now().UTC().Truncate(time.Second)
	}
	expiry := func(value time.Time, fallback time.Duration) time.Time {
		if value.IsZero() {
			return now.Add(fallback)
		}
		return value.UTC()
	}
	repository := &Repository{
		PublicDir: t.TempDir(), TargetPath: targetPath, TargetData: append([]byte(nil), targetData...),
		keys: map[string]*ecdsa.PrivateKey{},
	}
	repository.MetadataDir = filepath.Join(repository.PublicDir, "metadata")
	repository.TargetsDir = filepath.Join(repository.PublicDir, "targets")
	for _, directory := range []string{repository.MetadataDir, repository.TargetsDir} {
		if err := os.MkdirAll(directory, 0o700); err != nil {
			t.Fatal(err)
		}
	}

	repository.root = metadata.Root(expiry(options.RootExpires, 365*24*time.Hour))
	repository.root.Signed.ConsistentSnapshot = true
	repository.targets = metadata.Targets(expiry(options.TargetsExpires, 90*24*time.Hour))
	repository.snapshot = metadata.Snapshot(expiry(options.SnapshotExpires, 7*24*time.Hour))
	repository.timestamp = metadata.Timestamp(expiry(options.TimestampExpires, 24*time.Hour))

	for _, role := range []string{metadata.ROOT, metadata.TARGETS, metadata.SNAPSHOT, metadata.TIMESTAMP} {
		key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
		if err != nil {
			t.Fatal(err)
		}
		repository.keys[role] = key
		public, err := metadata.KeyFromPublicKey(key.Public())
		if err != nil {
			t.Fatal(err)
		}
		if err := repository.root.Signed.AddKey(public, role); err != nil {
			t.Fatal(err)
		}
	}
	if err := repository.addTarget(targetPath, targetData); err != nil {
		t.Fatal(err)
	}
	if err := repository.writeGeneration(); err != nil {
		t.Fatal(err)
	}
	rootBytes, err := repository.root.ToBytes(false)
	if err != nil {
		t.Fatal(err)
	}
	repository.Root = rootBytes
	return repository
}

func (r *Repository) AddOrReplaceTarget(t testing.TB, targetPath string, targetData []byte) {
	t.Helper()
	r.targets.Signed.Version++
	r.snapshot.Signed.Version++
	r.timestamp.Signed.Version++
	r.targets.ClearSignatures()
	r.snapshot.ClearSignatures()
	r.timestamp.ClearSignatures()
	if err := r.addTarget(targetPath, targetData); err != nil {
		t.Fatal(err)
	}
	if err := r.writeGeneration(); err != nil {
		t.Fatal(err)
	}
	r.TargetPath = targetPath
	r.TargetData = append([]byte(nil), targetData...)
}

// RotateTimestampKey publishes a new root that revokes the previous timestamp
// key, then publishes a fully new metadata generation signed by the new key.
func (r *Repository) RotateTimestampKey(t testing.TB) {
	t.Helper()
	oldKeyIDs := append([]string(nil), r.root.Signed.Roles[metadata.TIMESTAMP].KeyIDs...)
	if len(oldKeyIDs) != 1 {
		t.Fatalf("test repository requires exactly one timestamp key, found %d", len(oldKeyIDs))
	}
	newKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	public, err := metadata.KeyFromPublicKey(newKey.Public())
	if err != nil {
		t.Fatal(err)
	}
	if err := r.root.Signed.AddKey(public, metadata.TIMESTAMP); err != nil {
		t.Fatal(err)
	}
	if err := r.root.Signed.RevokeKey(oldKeyIDs[0], metadata.TIMESTAMP); err != nil {
		t.Fatal(err)
	}
	r.keys[metadata.TIMESTAMP] = newKey
	r.root.Signed.Version++
	r.targets.Signed.Version++
	r.snapshot.Signed.Version++
	r.timestamp.Signed.Version++
	r.root.ClearSignatures()
	r.targets.ClearSignatures()
	r.snapshot.ClearSignatures()
	r.timestamp.ClearSignatures()
	if err := r.writeGeneration(); err != nil {
		t.Fatal(err)
	}
}

func (r *Repository) MetadataPath(name string) string {
	return filepath.Join(r.MetadataDir, name)
}

func (r *Repository) PhysicalTargetPath(targetPath string, data []byte) string {
	digest := sha256.Sum256(data)
	base := filepath.Base(filepath.FromSlash(targetPath))
	directory := filepath.Dir(filepath.FromSlash(targetPath))
	return filepath.Join(r.TargetsDir, directory, hex.EncodeToString(digest[:])+"."+base)
}

func (r *Repository) addTarget(targetPath string, targetData []byte) error {
	info, err := metadata.TargetFile().FromBytes(targetPath, targetData, "sha256")
	if err != nil {
		return err
	}
	r.targets.Signed.Targets[targetPath] = info
	physical := r.PhysicalTargetPath(targetPath, targetData)
	if err := os.MkdirAll(filepath.Dir(physical), 0o700); err != nil {
		return err
	}
	return os.WriteFile(physical, targetData, 0o600)
}

func (r *Repository) writeGeneration() error {
	for _, role := range []string{metadata.TARGETS, metadata.ROOT} {
		var err error
		if role == metadata.TARGETS {
			err = sign(r.targets, r.keys[role])
		} else {
			r.root.ClearSignatures()
			err = sign(r.root, r.keys[role])
		}
		if err != nil {
			return err
		}
	}
	targetsBytes, err := r.targets.ToBytes(false)
	if err != nil {
		return err
	}
	r.snapshot.Signed.Meta["targets.json"] = metaFile(r.targets.Signed.Version, targetsBytes)
	if err := sign(r.snapshot, r.keys[metadata.SNAPSHOT]); err != nil {
		return err
	}
	snapshotBytes, err := r.snapshot.ToBytes(false)
	if err != nil {
		return err
	}
	r.timestamp.Signed.Meta["snapshot.json"] = metaFile(r.snapshot.Signed.Version, snapshotBytes)
	if err := sign(r.timestamp, r.keys[metadata.TIMESTAMP]); err != nil {
		return err
	}

	files := []struct {
		name string
		data []byte
	}{
		{fmt.Sprintf("%d.root.json", r.root.Signed.Version), mustBytes(r.root)},
		{fmt.Sprintf("%d.targets.json", r.targets.Signed.Version), targetsBytes},
		{fmt.Sprintf("%d.snapshot.json", r.snapshot.Signed.Version), snapshotBytes},
		{"timestamp.json", mustBytes(r.timestamp)},
	}
	for _, file := range files {
		if err := os.WriteFile(filepath.Join(r.MetadataDir, file.name), file.data, 0o600); err != nil {
			return err
		}
	}
	return nil
}

func sign[T metadata.Roles](value *metadata.Metadata[T], key *ecdsa.PrivateKey) error {
	signer, err := signature.LoadSigner(key, crypto.SHA256)
	if err != nil {
		return err
	}
	_, err = value.Sign(signer)
	return err
}

func metaFile(version int64, data []byte) *metadata.MetaFiles {
	hash := sha256.Sum256(data)
	return &metadata.MetaFiles{
		Version: version, Length: int64(len(data)),
		Hashes: metadata.Hashes{"sha256": metadata.HexBytes(hash[:])},
	}
}

func mustBytes[T metadata.Roles](value *metadata.Metadata[T]) []byte {
	data, err := value.ToBytes(false)
	if err != nil {
		panic(err)
	}
	return data
}

func TargetPath(environment, releaseID, name string) string {
	return strings.Join([]string{"environments", environment, "releases", releaseID, name}, "/")
}
