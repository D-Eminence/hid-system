package kmssigner

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/asn1"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"math/big"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/service/kms"
	"github.com/aws/aws-sdk-go-v2/service/kms/types"
	"github.com/sigstore/sigstore/pkg/signature/options"
	"github.com/theupdateframework/go-tuf/v2/metadata"
)

const testKeyARN = "arn:aws:kms:us-east-1:123456789012:key/12345678-1234-4abc-8def-1234567890ab"

type fakeClient struct {
	getPublicKey func(context.Context, *kms.GetPublicKeyInput, ...func(*kms.Options)) (*kms.GetPublicKeyOutput, error)
	sign         func(context.Context, *kms.SignInput, ...func(*kms.Options)) (*kms.SignOutput, error)
}

func (f *fakeClient) GetPublicKey(ctx context.Context, input *kms.GetPublicKeyInput, opts ...func(*kms.Options)) (*kms.GetPublicKeyOutput, error) {
	return f.getPublicKey(ctx, input, opts...)
}

func (f *fakeClient) Sign(ctx context.Context, input *kms.SignInput, opts ...func(*kms.Options)) (*kms.SignOutput, error) {
	return f.sign(ctx, input, opts...)
}

type testKey struct {
	private   *ecdsa.PrivateKey
	publicDER []byte
	checksum  string
}

func newTestKey(t *testing.T, curve elliptic.Curve) testKey {
	t.Helper()
	private, err := ecdsa.GenerateKey(curve, rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	publicDER, err := x509.MarshalPKIXPublicKey(&private.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	checksum := sha256.Sum256(publicDER)
	return testKey{private: private, publicDER: publicDER, checksum: hex.EncodeToString(checksum[:])}
}

func validPublicKeyOutput(key testKey) *kms.GetPublicKeyOutput {
	return &kms.GetPublicKeyOutput{
		KeyId:                 stringPointer(testKeyARN),
		KeySpec:               types.KeySpecEccNistP256,
		CustomerMasterKeySpec: types.CustomerMasterKeySpecEccNistP256,
		KeyUsage:              types.KeyUsageTypeSignVerify,
		PublicKey:             bytes.Clone(key.publicDER),
		SigningAlgorithms:     []types.SigningAlgorithmSpec{types.SigningAlgorithmSpecEcdsaSha256},
	}
}

func validSignOutput(key testKey, input *kms.SignInput) (*kms.SignOutput, error) {
	if input == nil || input.KeyId == nil || *input.KeyId != testKeyARN {
		return nil, errors.New("unexpected key ARN")
	}
	if input.MessageType != types.MessageTypeDigest || input.SigningAlgorithm != types.SigningAlgorithmSpecEcdsaSha256 {
		return nil, errors.New("unexpected signing mode")
	}
	if len(input.Message) != sha256.Size || input.DryRun != nil || len(input.GrantTokens) != 0 {
		return nil, errors.New("ambiguous signing request")
	}
	signature, err := ecdsa.SignASN1(rand.Reader, key.private, input.Message)
	if err != nil {
		return nil, err
	}
	return &kms.SignOutput{
		KeyId:            stringPointer(testKeyARN),
		SigningAlgorithm: types.SigningAlgorithmSpecEcdsaSha256,
		Signature:        signature,
	}, nil
}

func newValidSigner(t *testing.T) (*Signer, testKey, *fakeClient) {
	t.Helper()
	key := newTestKey(t, elliptic.P256())
	client := &fakeClient{
		getPublicKey: func(_ context.Context, input *kms.GetPublicKeyInput, opts ...func(*kms.Options)) (*kms.GetPublicKeyOutput, error) {
			if input == nil || input.KeyId == nil || *input.KeyId != testKeyARN || len(input.GrantTokens) != 0 || len(opts) != 0 {
				return nil, errors.New("unexpected GetPublicKey request")
			}
			return validPublicKeyOutput(key), nil
		},
		sign: func(_ context.Context, input *kms.SignInput, opts ...func(*kms.Options)) (*kms.SignOutput, error) {
			if len(opts) != 0 {
				return nil, errors.New("unexpected Sign options")
			}
			return validSignOutput(key, input)
		},
	}
	signer, err := New(context.Background(), client, Config{KeyARN: testKeyARN, PublicKeyDERChecksum: key.checksum})
	if err != nil {
		t.Fatal(err)
	}
	return signer, key, client
}

func TestSignerWorksWithGoTUFMetadataSignAndVerify(t *testing.T) {
	signer, _, _ := newValidSigner(t)
	root := metadata.Root(time.Now().UTC().Add(time.Hour))
	timestamp := metadata.Timestamp(time.Now().UTC().Add(time.Hour))
	publicKey, err := signer.PublicKey()
	if err != nil {
		t.Fatal(err)
	}
	tufKey, err := metadata.KeyFromPublicKey(publicKey)
	if err != nil {
		t.Fatal(err)
	}
	if err := root.Signed.AddKey(tufKey, metadata.TIMESTAMP); err != nil {
		t.Fatal(err)
	}
	if _, err := timestamp.Sign(signer); err != nil {
		t.Fatalf("go-tuf metadata.Sign rejected KMS signer: %v", err)
	}
	if err := root.VerifyDelegate(metadata.TIMESTAMP, timestamp); err != nil {
		t.Fatalf("go-tuf failed to verify KMS-backed signature: %v", err)
	}
}

func TestNewRejectsInvalidConfigurationWithoutCallingKMS(t *testing.T) {
	key := newTestKey(t, elliptic.P256())
	var calls atomic.Int64
	client := &fakeClient{
		getPublicKey: func(context.Context, *kms.GetPublicKeyInput, ...func(*kms.Options)) (*kms.GetPublicKeyOutput, error) {
			calls.Add(1)
			return validPublicKeyOutput(key), nil
		},
		sign: func(context.Context, *kms.SignInput, ...func(*kms.Options)) (*kms.SignOutput, error) {
			return nil, errors.New("not used")
		},
	}
	invalid := []struct {
		name   string
		ctx    context.Context
		client Client
		config Config
	}{
		{name: "nil context", client: client, config: Config{KeyARN: testKeyARN, PublicKeyDERChecksum: key.checksum}},
		{name: "nil client", ctx: context.Background(), config: Config{KeyARN: testKeyARN, PublicKeyDERChecksum: key.checksum}},
		{name: "typed nil client", ctx: context.Background(), client: (*fakeClient)(nil), config: Config{KeyARN: testKeyARN, PublicKeyDERChecksum: key.checksum}},
		{name: "bare key ID", ctx: context.Background(), client: client, config: Config{KeyARN: "12345678-1234-4abc-8def-1234567890ab", PublicKeyDERChecksum: key.checksum}},
		{name: "alias ARN", ctx: context.Background(), client: client, config: Config{KeyARN: "arn:aws:kms:us-east-1:123456789012:alias/timestamp", PublicKeyDERChecksum: key.checksum}},
		{name: "malformed account", ctx: context.Background(), client: client, config: Config{KeyARN: "arn:aws:kms:us-east-1:123:key/12345678-1234-4abc-8def-1234567890ab", PublicKeyDERChecksum: key.checksum}},
		{name: "uppercase checksum", ctx: context.Background(), client: client, config: Config{KeyARN: testKeyARN, PublicKeyDERChecksum: "ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789"}},
		{name: "short checksum", ctx: context.Background(), client: client, config: Config{KeyARN: testKeyARN, PublicKeyDERChecksum: "00"}},
	}
	for _, test := range invalid {
		t.Run(test.name, func(t *testing.T) {
			_, err := New(test.ctx, test.client, test.config)
			if !errors.Is(err, ErrInvalidConfiguration) {
				t.Fatalf("got %v, want ErrInvalidConfiguration", err)
			}
		})
	}
	if calls.Load() != 0 {
		t.Fatalf("KMS called %d times for invalid configuration", calls.Load())
	}

	canceled, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := New(canceled, client, Config{KeyARN: testKeyARN, PublicKeyDERChecksum: key.checksum})
	if !errors.Is(err, context.Canceled) || calls.Load() != 0 {
		t.Fatalf("canceled constructor: error=%v calls=%d", err, calls.Load())
	}
}

func TestNewForwardsContextAndUsesExactImmutableARN(t *testing.T) {
	key := newTestKey(t, elliptic.P256())
	type contextKey string
	ctx := context.WithValue(context.Background(), contextKey("release"), "r42")
	client := &fakeClient{
		getPublicKey: func(got context.Context, input *kms.GetPublicKeyInput, opts ...func(*kms.Options)) (*kms.GetPublicKeyOutput, error) {
			if got.Value(contextKey("release")) != "r42" {
				return nil, errors.New("context value missing")
			}
			if input == nil || input.KeyId == nil || *input.KeyId != testKeyARN || len(opts) != 0 {
				return nil, errors.New("key ARN was not exact")
			}
			// A hostile implementation mutating the request pointer must not
			// mutate the signer's configured key ARN.
			*input.KeyId = "mutated"
			return validPublicKeyOutput(key), nil
		},
		sign: func(_ context.Context, input *kms.SignInput, _ ...func(*kms.Options)) (*kms.SignOutput, error) {
			return validSignOutput(key, input)
		},
	}
	signer, err := New(ctx, client, Config{KeyARN: testKeyARN, PublicKeyDERChecksum: key.checksum})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := signer.SignMessage(bytes.NewReader([]byte("payload"))); err != nil {
		t.Fatalf("request mutation affected signer state: %v", err)
	}
}

func TestNewFailsClosedOnPublicKeyRPCErrorAndAmbiguity(t *testing.T) {
	key := newTestKey(t, elliptic.P256())
	rpcError := errors.New("kms unavailable")
	t.Run("RPC error", func(t *testing.T) {
		client := &fakeClient{
			getPublicKey: func(context.Context, *kms.GetPublicKeyInput, ...func(*kms.Options)) (*kms.GetPublicKeyOutput, error) {
				return validPublicKeyOutput(key), rpcError
			},
			sign: func(context.Context, *kms.SignInput, ...func(*kms.Options)) (*kms.SignOutput, error) { return nil, nil },
		}
		_, err := New(context.Background(), client, Config{KeyARN: testKeyARN, PublicKeyDERChecksum: key.checksum})
		if !errors.Is(err, rpcError) {
			t.Fatalf("got %v, want wrapped RPC error", err)
		}
	})

	cases := []struct {
		name   string
		mutate func(*kms.GetPublicKeyOutput) Config
		nilOut bool
	}{
		{name: "nil output", nilOut: true},
		{name: "nil key ID", mutate: func(output *kms.GetPublicKeyOutput) Config { output.KeyId = nil; return configFor(key) }},
		{name: "wrong key ID", mutate: func(output *kms.GetPublicKeyOutput) Config {
			output.KeyId = stringPointer(testKeyARN + "0")
			return configFor(key)
		}},
		{name: "missing key spec", mutate: func(output *kms.GetPublicKeyOutput) Config { output.KeySpec = ""; return configFor(key) }},
		{name: "wrong key spec", mutate: func(output *kms.GetPublicKeyOutput) Config {
			output.KeySpec = types.KeySpecEccNistP384
			return configFor(key)
		}},
		{name: "conflicting deprecated spec", mutate: func(output *kms.GetPublicKeyOutput) Config {
			output.CustomerMasterKeySpec = types.CustomerMasterKeySpecRsa2048
			return configFor(key)
		}},
		{name: "wrong usage", mutate: func(output *kms.GetPublicKeyOutput) Config {
			output.KeyUsage = types.KeyUsageTypeEncryptDecrypt
			return configFor(key)
		}},
		{name: "missing signing algorithm", mutate: func(output *kms.GetPublicKeyOutput) Config { output.SigningAlgorithms = nil; return configFor(key) }},
		{name: "extra signing algorithm", mutate: func(output *kms.GetPublicKeyOutput) Config {
			output.SigningAlgorithms = append(output.SigningAlgorithms, types.SigningAlgorithmSpecEcdsaSha384)
			return configFor(key)
		}},
		{name: "wrong signing algorithm", mutate: func(output *kms.GetPublicKeyOutput) Config {
			output.SigningAlgorithms[0] = types.SigningAlgorithmSpecEcdsaSha384
			return configFor(key)
		}},
		{name: "encryption algorithm present", mutate: func(output *kms.GetPublicKeyOutput) Config {
			output.EncryptionAlgorithms = []types.EncryptionAlgorithmSpec{types.EncryptionAlgorithmSpecRsaesOaepSha256}
			return configFor(key)
		}},
		{name: "key agreement algorithm present", mutate: func(output *kms.GetPublicKeyOutput) Config {
			output.KeyAgreementAlgorithms = []types.KeyAgreementAlgorithmSpec{types.KeyAgreementAlgorithmSpecEcdh}
			return configFor(key)
		}},
		{name: "empty public key", mutate: func(output *kms.GetPublicKeyOutput) Config { output.PublicKey = nil; return configFor(key) }},
		{name: "checksum mismatch", mutate: func(output *kms.GetPublicKeyOutput) Config { output.PublicKey[0] ^= 1; return configFor(key) }},
		{name: "invalid SPKI with matching checksum", mutate: func(output *kms.GetPublicKeyOutput) Config {
			output.PublicKey = []byte{0x30, 0x00}
			return configForDER(output.PublicKey)
		}},
		{name: "trailing SPKI data", mutate: func(output *kms.GetPublicKeyOutput) Config {
			output.PublicKey = append(output.PublicKey, 0)
			return configForDER(output.PublicKey)
		}},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			output := validPublicKeyOutput(key)
			config := configFor(key)
			if test.mutate != nil {
				config = test.mutate(output)
			}
			client := &fakeClient{
				getPublicKey: func(context.Context, *kms.GetPublicKeyInput, ...func(*kms.Options)) (*kms.GetPublicKeyOutput, error) {
					if test.nilOut {
						return nil, nil
					}
					return output, nil
				},
				sign: func(context.Context, *kms.SignInput, ...func(*kms.Options)) (*kms.SignOutput, error) { return nil, nil },
			}
			_, err := New(context.Background(), client, config)
			if !errors.Is(err, ErrInvalidKMSResponse) {
				t.Fatalf("got %v, want ErrInvalidKMSResponse", err)
			}
		})
	}
}

func TestNewRejectsNonP256PublicKeysEvenWhenMetadataClaimsP256(t *testing.T) {
	keys := []struct {
		name string
		der  func(*testing.T) []byte
	}{
		{name: "P-384", der: func(t *testing.T) []byte { return newTestKey(t, elliptic.P384()).publicDER }},
		{name: "RSA", der: func(t *testing.T) []byte {
			private, err := rsa.GenerateKey(rand.Reader, 2048)
			if err != nil {
				t.Fatal(err)
			}
			der, err := x509.MarshalPKIXPublicKey(&private.PublicKey)
			if err != nil {
				t.Fatal(err)
			}
			return der
		}},
	}
	for _, test := range keys {
		t.Run(test.name, func(t *testing.T) {
			output := validPublicKeyOutput(newTestKey(t, elliptic.P256()))
			output.PublicKey = test.der(t)
			client := &fakeClient{
				getPublicKey: func(context.Context, *kms.GetPublicKeyInput, ...func(*kms.Options)) (*kms.GetPublicKeyOutput, error) {
					return output, nil
				},
				sign: func(context.Context, *kms.SignInput, ...func(*kms.Options)) (*kms.SignOutput, error) { return nil, nil },
			}
			_, err := New(context.Background(), client, configForDER(output.PublicKey))
			if !errors.Is(err, ErrInvalidKMSResponse) {
				t.Fatalf("got %v, want ErrInvalidKMSResponse", err)
			}
		})
	}
}

func TestSignMessageHashesExactMessageAndForwardsContext(t *testing.T) {
	signer, key, client := newValidSigner(t)
	type contextKey string
	ctx := context.WithValue(context.Background(), contextKey("operation"), "timestamp-sign")
	message := bytes.Repeat([]byte("canonical TUF payload"), 4096)
	expected := sha256.Sum256(message)
	client.sign = func(got context.Context, input *kms.SignInput, opts ...func(*kms.Options)) (*kms.SignOutput, error) {
		if got.Value(contextKey("operation")) != "timestamp-sign" {
			return nil, errors.New("sign context not forwarded")
		}
		if !bytes.Equal(input.Message, expected[:]) {
			return nil, errors.New("KMS did not receive exact SHA-256 digest")
		}
		if len(opts) != 0 {
			return nil, errors.New("unexpected AWS option")
		}
		return validSignOutput(key, input)
	}
	signature, err := signer.SignMessage(bytes.NewReader(message), options.WithContext(ctx))
	if err != nil {
		t.Fatal(err)
	}
	if !ecdsa.VerifyASN1(&key.private.PublicKey, expected[:], signature) {
		t.Fatal("returned signature does not cover exact message digest")
	}
}

func TestSignMessageRejectsReaderFailuresAndUnsupportedOptionsBeforeKMS(t *testing.T) {
	signer, _, client := newValidSigner(t)
	var calls atomic.Int64
	client.sign = func(context.Context, *kms.SignInput, ...func(*kms.Options)) (*kms.SignOutput, error) {
		calls.Add(1)
		return nil, errors.New("must not be called")
	}

	readerError := errors.New("reader failed")
	readers := []struct {
		name   string
		reader io.Reader
	}{
		{name: "nil"},
		{name: "typed nil", reader: (*bytes.Reader)(nil)},
		{name: "error", reader: errorReader{err: readerError}},
	}
	for _, test := range readers {
		t.Run(test.name, func(t *testing.T) {
			_, err := signer.SignMessage(test.reader)
			if err == nil {
				t.Fatal("expected reader rejection")
			}
		})
	}

	version := ""
	optionCases := []struct {
		name string
		opt  options.RequestKeyVersion
	}{
		{name: "key version", opt: options.WithKeyVersion("other")},
	}
	for _, test := range optionCases {
		t.Run(test.name, func(t *testing.T) {
			_, err := signer.SignMessage(bytes.NewReader(nil), test.opt)
			if err == nil {
				t.Fatal("expected unsupported option rejection")
			}
		})
	}
	if _, err := signer.SignMessage(bytes.NewReader(nil), options.WithDigest(make([]byte, sha256.Size))); err == nil {
		t.Fatal("caller-supplied digest was accepted")
	}
	if _, err := signer.SignMessage(bytes.NewReader(nil), options.ReturnKeyVersionUsed(&version)); err == nil {
		t.Fatal("key-version output option was accepted")
	}
	if calls.Load() != 0 {
		t.Fatalf("KMS called %d times for rejected input", calls.Load())
	}
}

func TestSignMessageHonorsCancellationBeforeKMS(t *testing.T) {
	signer, _, client := newValidSigner(t)
	var calls atomic.Int64
	client.sign = func(context.Context, *kms.SignInput, ...func(*kms.Options)) (*kms.SignOutput, error) {
		calls.Add(1)
		return nil, nil
	}
	canceled, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := signer.SignMessage(bytes.NewReader([]byte("payload")), options.WithContext(canceled))
	if !errors.Is(err, context.Canceled) || calls.Load() != 0 {
		t.Fatalf("error=%v calls=%d", err, calls.Load())
	}
}

func TestSignMessageWrapsKMSErrorAndRejectsAmbiguousResponses(t *testing.T) {
	signer, key, client := newValidSigner(t)
	rpcError := errors.New("access denied")
	client.sign = func(_ context.Context, input *kms.SignInput, _ ...func(*kms.Options)) (*kms.SignOutput, error) {
		output, err := validSignOutput(key, input)
		return output, errors.Join(err, rpcError)
	}
	if _, err := signer.SignMessage(bytes.NewReader(nil)); !errors.Is(err, rpcError) {
		t.Fatalf("got %v, want wrapped RPC error", err)
	}

	otherKey := newTestKey(t, elliptic.P256())
	cases := []struct {
		name   string
		mutate func(*kms.SignOutput, []byte)
		nilOut bool
		want   error
	}{
		{name: "nil output", nilOut: true, want: ErrInvalidKMSResponse},
		{name: "nil key ID", mutate: func(output *kms.SignOutput, _ []byte) { output.KeyId = nil }, want: ErrInvalidKMSResponse},
		{name: "wrong key ID", mutate: func(output *kms.SignOutput, _ []byte) { output.KeyId = stringPointer(testKeyARN + "0") }, want: ErrInvalidKMSResponse},
		{name: "missing algorithm", mutate: func(output *kms.SignOutput, _ []byte) { output.SigningAlgorithm = "" }, want: ErrInvalidKMSResponse},
		{name: "wrong algorithm", mutate: func(output *kms.SignOutput, _ []byte) {
			output.SigningAlgorithm = types.SigningAlgorithmSpecEcdsaSha384
		}, want: ErrInvalidKMSResponse},
		{name: "empty signature", mutate: func(output *kms.SignOutput, _ []byte) { output.Signature = nil }, want: ErrSignatureVerification},
		{name: "invalid DER", mutate: func(output *kms.SignOutput, _ []byte) { output.Signature = []byte{0x30, 0x00} }, want: ErrSignatureVerification},
		{name: "trailing DER data", mutate: func(output *kms.SignOutput, _ []byte) { output.Signature = append(output.Signature, 0) }, want: ErrSignatureVerification},
		{name: "non-minimal DER integer", mutate: func(output *kms.SignOutput, _ []byte) {
			output.Signature = []byte{0x30, 0x07, 0x02, 0x02, 0x00, 0x01, 0x02, 0x01, 0x01}
		}, want: ErrSignatureVerification},
		{name: "zero scalar", mutate: func(output *kms.SignOutput, _ []byte) {
			output.Signature, _ = asn1.Marshal(ecdsaSignature{R: big.NewInt(0), S: big.NewInt(1)})
		}, want: ErrSignatureVerification},
		{name: "out-of-range scalar", mutate: func(output *kms.SignOutput, _ []byte) {
			output.Signature, _ = asn1.Marshal(ecdsaSignature{R: elliptic.P256().Params().N, S: big.NewInt(1)})
		}, want: ErrSignatureVerification},
		{name: "wrong signing key", mutate: func(output *kms.SignOutput, digest []byte) {
			output.Signature, _ = ecdsa.SignASN1(rand.Reader, otherKey.private, digest)
		}, want: ErrSignatureVerification},
		{name: "wrong digest", mutate: func(output *kms.SignOutput, _ []byte) {
			wrong := sha256.Sum256([]byte("other"))
			output.Signature, _ = ecdsa.SignASN1(rand.Reader, key.private, wrong[:])
		}, want: ErrSignatureVerification},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			client.sign = func(_ context.Context, input *kms.SignInput, _ ...func(*kms.Options)) (*kms.SignOutput, error) {
				if test.nilOut {
					return nil, nil
				}
				output, err := validSignOutput(key, input)
				if err != nil {
					return nil, err
				}
				if test.mutate != nil {
					test.mutate(output, input.Message)
				}
				return output, nil
			}
			_, err := signer.SignMessage(bytes.NewReader([]byte("payload")))
			if !errors.Is(err, test.want) {
				t.Fatalf("got %v, want %v", err, test.want)
			}
		})
	}
}

func TestPublicKeyIsDefensiveCopyAndOptionsFailClosed(t *testing.T) {
	signer, key, _ := newValidSigner(t)
	firstAny, err := signer.PublicKey()
	if err != nil {
		t.Fatal(err)
	}
	first := firstAny.(*ecdsa.PublicKey)
	first.X.SetInt64(1)
	first.Y.SetInt64(1)
	secondAny, err := signer.PublicKey(options.WithContext(context.Background()))
	if err != nil {
		t.Fatal(err)
	}
	second := secondAny.(*ecdsa.PublicKey)
	if second.X.Cmp(key.private.X) != 0 || second.Y.Cmp(key.private.Y) != 0 {
		t.Fatal("caller mutation escaped defensive public-key copy")
	}
	if _, err := signer.SignMessage(bytes.NewReader([]byte("still valid"))); err != nil {
		t.Fatalf("caller mutation affected local verification: %v", err)
	}
	if _, err := signer.PublicKey(options.WithKeyVersion("other")); err == nil {
		t.Fatal("unsupported public-key option was accepted")
	}
	canceled, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := signer.PublicKey(options.WithContext(canceled)); !errors.Is(err, context.Canceled) {
		t.Fatalf("got %v, want context.Canceled", err)
	}
	var nilSigner *Signer
	if _, err := nilSigner.PublicKey(); !errors.Is(err, ErrInvalidConfiguration) {
		t.Fatalf("nil PublicKey error = %v", err)
	}
	if _, err := nilSigner.SignMessage(bytes.NewReader(nil)); !errors.Is(err, ErrInvalidConfiguration) {
		t.Fatalf("nil SignMessage error = %v", err)
	}
}

func TestSignerConcurrentUse(t *testing.T) {
	signer, _, client := newValidSigner(t)
	var calls atomic.Int64
	original := client.sign
	client.sign = func(ctx context.Context, input *kms.SignInput, opts ...func(*kms.Options)) (*kms.SignOutput, error) {
		calls.Add(1)
		return original(ctx, input, opts...)
	}
	const workers = 32
	var wait sync.WaitGroup
	errorsChannel := make(chan error, workers)
	for index := 0; index < workers; index++ {
		wait.Add(1)
		go func(index int) {
			defer wait.Done()
			_, err := signer.SignMessage(bytes.NewReader([]byte(fmt.Sprintf("payload-%d", index))))
			errorsChannel <- err
		}(index)
	}
	wait.Wait()
	close(errorsChannel)
	for err := range errorsChannel {
		if err != nil {
			t.Error(err)
		}
	}
	if calls.Load() != workers {
		t.Fatalf("got %d calls, want %d", calls.Load(), workers)
	}
}

type errorReader struct{ err error }

func (r errorReader) Read([]byte) (int, error) { return 0, r.err }

func configFor(key testKey) Config {
	return Config{KeyARN: testKeyARN, PublicKeyDERChecksum: key.checksum}
}

func configForDER(der []byte) Config {
	checksum := sha256.Sum256(der)
	return Config{KeyARN: testKeyARN, PublicKeyDERChecksum: hex.EncodeToString(checksum[:])}
}

func stringPointer(value string) *string { return &value }
