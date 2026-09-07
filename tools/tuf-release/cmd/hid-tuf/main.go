package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/D-Eminence/hid-system/tools/tuf-release/internal/frontendarchive"
	"github.com/D-Eminence/hid-system/tools/tuf-release/internal/tufclient"
	"golang.org/x/sys/unix"
)

const usage = `Usage:
  hid-tuf refresh --config TRUST.json
  hid-tuf get --config TRUST.json --release RELEASE --target LOGICAL_PATH --output FILE
  hid-tuf get-batch --config TRUST.json --release RELEASE --request REQUEST.json
  hid-tuf pack-frontend --root DIST --application APP --git-sha SHA --archive FILE --manifest FILE
  hid-tuf extract-frontend --archive FILE --manifest FILE --output DIRECTORY

The refresh/get commands require an out-of-band pinned root and durable state.
This binary has no signing or trust-on-first-use command.`

func main() {
	if err := run(os.Args[1:], os.Stdout, os.Stderr); err != nil {
		fmt.Fprintf(os.Stderr, "hid-tuf: %v\n", err)
		os.Exit(1)
	}
}

func run(arguments []string, stdout, stderr io.Writer) error {
	if len(arguments) == 0 {
		fmt.Fprintln(stderr, usage)
		return errors.New("a command is required")
	}
	switch arguments[0] {
	case "refresh":
		flags := commandFlags("refresh", stderr)
		configPath := flags.String("config", "", "trusted environment configuration")
		if err := parseExactFlags(flags, arguments[1:], "config"); err != nil {
			return err
		}
		client, err := openClient(*configPath)
		if err != nil {
			return err
		}
		state, err := client.Refresh()
		if err != nil {
			return errors.Join(err, client.Close())
		}
		if err := client.Close(); err != nil {
			return err
		}
		return writeJSON(stdout, state)
	case "get":
		flags := commandFlags("get", stderr)
		configPath := flags.String("config", "", "trusted environment configuration")
		release := flags.String("release", "", "explicit immutable release ID")
		target := flags.String("target", "", "exact logical target path")
		output := flags.String("output", "", "new output file")
		if err := parseExactFlags(flags, arguments[1:], "config", "release", "target", "output"); err != nil {
			return err
		}
		client, err := openClient(*configPath)
		if err != nil {
			return err
		}
		if err := client.DownloadReleaseTarget(*release, *target, *output); err != nil {
			return errors.Join(err, client.Close())
		}
		if err := client.Close(); err != nil {
			return err
		}
		return writeJSON(stdout, map[string]string{"status": "verified", "target": *target, "output": *output})
	case "get-batch":
		flags := commandFlags("get-batch", stderr)
		configPath := flags.String("config", "", "trusted environment configuration")
		release := flags.String("release", "", "explicit immutable release ID")
		requestPath := flags.String("request", "", "strict bounded batch request")
		if err := parseExactFlags(flags, arguments[1:], "config", "release", "request"); err != nil {
			return err
		}
		request, err := tufclient.LoadBatchRequest(*requestPath)
		if err != nil {
			return err
		}
		client, err := openClient(*configPath)
		if err != nil {
			return err
		}
		if err := client.DownloadReleaseTargets(*release, request); err != nil {
			return errors.Join(err, client.Close())
		}
		if err := client.Close(); err != nil {
			return err
		}
		return writeJSON(stdout, map[string]any{
			"status": "verified", "release": *release, "target_count": len(request.Targets),
		})
	case "pack-frontend":
		flags := commandFlags("pack-frontend", stderr)
		root := flags.String("root", "", "built frontend directory")
		application := flags.String("application", "", "canonical application name")
		gitSHA := flags.String("git-sha", "", "exact 40-character Git SHA")
		archivePath := flags.String("archive", "", "new deterministic USTAR output")
		manifestPath := flags.String("manifest", "", "new content-manifest output")
		if err := parseExactFlags(flags, arguments[1:], "root", "application", "git-sha", "archive", "manifest"); err != nil {
			return err
		}
		manifest, err := packFrontend(*root, *application, *gitSHA, *archivePath, *manifestPath)
		if err != nil {
			return err
		}
		return writeJSON(stdout, manifest)
	case "extract-frontend":
		flags := commandFlags("extract-frontend", stderr)
		archivePath := flags.String("archive", "", "verified USTAR input")
		manifestPath := flags.String("manifest", "", "verified content manifest")
		output := flags.String("output", "", "new extracted directory")
		if err := parseExactFlags(flags, arguments[1:], "archive", "manifest", "output"); err != nil {
			return err
		}
		return extractFrontend(*archivePath, *manifestPath, *output)
	case "help", "--help", "-h":
		fmt.Fprintln(stdout, usage)
		return nil
	default:
		return fmt.Errorf("unknown command %q", arguments[0])
	}
}

func openClient(configPath string) (*tufclient.Client, error) {
	configuration, err := tufclient.LoadConfig(configPath)
	if err != nil {
		return nil, err
	}
	return tufclient.Open(configuration)
}

func packFrontend(root, application, gitSHA, archivePath, manifestPath string) (frontendarchive.Manifest, error) {
	if archivePath == manifestPath {
		return frontendarchive.Manifest{}, errors.New("archive and manifest outputs must differ")
	}
	for _, output := range []string{archivePath, manifestPath} {
		if _, err := os.Lstat(output); err == nil {
			return frontendarchive.Manifest{}, fmt.Errorf("output %q already exists", output)
		} else if !errors.Is(err, os.ErrNotExist) {
			return frontendarchive.Manifest{}, err
		}
		if err := os.MkdirAll(filepath.Dir(output), 0o700); err != nil {
			return frontendarchive.Manifest{}, err
		}
	}
	archive, err := os.CreateTemp(filepath.Dir(archivePath), ".hid-frontend-archive-")
	if err != nil {
		return frontendarchive.Manifest{}, err
	}
	archiveTemporary := archive.Name()
	defer os.Remove(archiveTemporary)
	manifest, packErr := frontendarchive.Pack(root, application, gitSHA, archive, frontendarchive.DefaultLimits())
	packErr = errors.Join(packErr, archive.Sync(), archive.Close())
	if packErr != nil {
		return frontendarchive.Manifest{}, packErr
	}
	manifestBytes, err := manifest.Bytes()
	if err != nil {
		return frontendarchive.Manifest{}, err
	}
	manifestFile, err := os.CreateTemp(filepath.Dir(manifestPath), ".hid-frontend-manifest-")
	if err != nil {
		return frontendarchive.Manifest{}, err
	}
	manifestTemporary := manifestFile.Name()
	defer os.Remove(manifestTemporary)
	if err := manifestFile.Chmod(0o600); err != nil {
		manifestFile.Close()
		return frontendarchive.Manifest{}, err
	}
	if err := writeAll(manifestFile, manifestBytes); err != nil {
		manifestFile.Close()
		return frontendarchive.Manifest{}, err
	}
	if err := errors.Join(manifestFile.Sync(), manifestFile.Close()); err != nil {
		return frontendarchive.Manifest{}, err
	}
	if err := os.Chmod(archiveTemporary, 0o600); err != nil {
		return frontendarchive.Manifest{}, err
	}
	if err := os.Link(archiveTemporary, archivePath); err != nil {
		return frontendarchive.Manifest{}, err
	}
	if err := os.Link(manifestTemporary, manifestPath); err != nil {
		return frontendarchive.Manifest{}, errors.Join(err, os.Remove(archivePath))
	}
	directories := map[string]struct{}{
		filepath.Dir(archivePath):  {},
		filepath.Dir(manifestPath): {},
	}
	for directory := range directories {
		if err := syncDirectory(directory); err != nil {
			return frontendarchive.Manifest{}, err
		}
	}
	return manifest, nil
}

func extractFrontend(archivePath, manifestPath, output string) error {
	manifestBytes, err := readBoundedRegular(manifestPath, 8<<20)
	if err != nil {
		return err
	}
	manifest, err := frontendarchive.ParseManifest(manifestBytes)
	if err != nil {
		return err
	}
	archive, err := openBoundedRegular(archivePath, 25<<20)
	if err != nil {
		return err
	}
	extractErr := frontendarchive.Extract(io.LimitReader(archive, (25<<20)+1), manifest, output, frontendarchive.DefaultLimits())
	return errors.Join(extractErr, archive.Close())
}

func commandFlags(name string, stderr io.Writer) *flag.FlagSet {
	flags := flag.NewFlagSet(name, flag.ContinueOnError)
	flags.SetOutput(stderr)
	return flags
}

// parseExactFlags keeps the security-sensitive command line unambiguous: each
// documented long option must occur exactly once, with its value in the next
// argument. In particular, Go flag's last-value-wins duplicate behavior is not
// accepted for repository, release, trust-root, or output selections.
func parseExactFlags(flags *flag.FlagSet, arguments []string, names ...string) error {
	allowed := make(map[string]struct{}, len(names))
	for _, name := range names {
		allowed[name] = struct{}{}
	}
	if len(arguments) != len(names)*2 {
		return fmt.Errorf("%s requires each documented option exactly once", flags.Name())
	}
	seen := make(map[string]struct{}, len(names))
	for index := 0; index < len(arguments); index += 2 {
		option := arguments[index]
		if !strings.HasPrefix(option, "--") || strings.Contains(option, "=") || len(option) == 2 {
			return fmt.Errorf("%s accepts only documented --name value options", flags.Name())
		}
		name := strings.TrimPrefix(option, "--")
		if _, ok := allowed[name]; !ok {
			return fmt.Errorf("unknown %s option %q", flags.Name(), option)
		}
		if _, duplicate := seen[name]; duplicate {
			return fmt.Errorf("%s option %q was provided more than once", flags.Name(), option)
		}
		if arguments[index+1] == "" {
			return fmt.Errorf("%s option %q has an empty value", flags.Name(), option)
		}
		seen[name] = struct{}{}
	}
	for _, name := range names {
		if _, ok := seen[name]; !ok {
			return fmt.Errorf("%s requires --%s", flags.Name(), name)
		}
	}
	if err := flags.Parse(arguments); err != nil {
		return err
	}
	if flags.NArg() != 0 {
		return fmt.Errorf("%s does not accept positional arguments", flags.Name())
	}
	return nil
}

func writeAll(output io.Writer, data []byte) error {
	written, err := output.Write(data)
	if err != nil {
		return err
	}
	if written != len(data) {
		return io.ErrShortWrite
	}
	return nil
}

func readBoundedRegular(filePath string, maximum int64) ([]byte, error) {
	file, err := openBoundedRegular(filePath, maximum)
	if err != nil {
		return nil, err
	}
	data, readErr := io.ReadAll(io.LimitReader(file, maximum+1))
	closeErr := file.Close()
	if readErr != nil || closeErr != nil {
		return nil, errors.Join(readErr, closeErr)
	}
	if int64(len(data)) > maximum {
		return nil, errors.New("regular file grew beyond its configured bound while being read")
	}
	return data, nil
}

func openBoundedRegular(filePath string, maximum int64) (*os.File, error) {
	if maximum < 0 {
		return nil, errors.New("maximum regular-file size must not be negative")
	}
	fileDescriptor, err := unix.Open(filePath, unix.O_RDONLY|unix.O_CLOEXEC|unix.O_NOFOLLOW|unix.O_NONBLOCK, 0)
	if err != nil {
		return nil, err
	}
	file := os.NewFile(uintptr(fileDescriptor), filePath)
	if file == nil {
		_ = unix.Close(fileDescriptor)
		return nil, errors.New("wrap bounded regular-file descriptor")
	}
	info, err := file.Stat()
	if err != nil {
		file.Close()
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Size() > maximum {
		file.Close()
		return nil, errors.New("path is not a bounded regular file")
	}
	return file, nil
}

func syncDirectory(directory string) error {
	file, err := os.Open(directory)
	if err != nil {
		return err
	}
	return errors.Join(file.Sync(), file.Close())
}

func writeJSON(output io.Writer, value any) error {
	encoder := json.NewEncoder(output)
	encoder.SetEscapeHTML(false)
	encoder.SetIndent("", "  ")
	return encoder.Encode(value)
}
