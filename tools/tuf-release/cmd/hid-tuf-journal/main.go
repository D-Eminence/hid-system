// hid-tuf-journal is the protected runner's durable coordination adapter. It
// never signs, modifies a broker checkpoint or performs a Cloudflare action.
package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/D-Eminence/hid-system/tools/tuf-release/internal/awsbroker"
	"github.com/D-Eminence/hid-system/tools/tuf-release/internal/publicationjournal"
	"github.com/D-Eminence/hid-system/tools/tuf-release/internal/repository"
	"github.com/D-Eminence/hid-system/tools/tuf-release/internal/signingbroker"
	"github.com/D-Eminence/hid-system/tools/tuf-release/internal/strictjson"
	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

type journalRequest struct {
	Action              string                                 `json:"action"`
	Binding             publicationjournal.Binding             `json:"binding"`
	Owner               string                                 `json:"owner"`
	Revision            int64                                  `json:"revision"`
	Phase               publicationjournal.Phase               `json:"phase"`
	EvidenceHash        string                                 `json:"evidence_sha256"`
	Authorization       signingbroker.PublicationAuthorization `json:"authorization"`
	Confirmation        signingbroker.PublicationConfirmation  `json:"confirmation"`
	FailureCode         string                                 `json:"failure_code"`
	Evidence            json.RawMessage                        `json:"evidence"`
	RepositoryDirectory string                                 `json:"repository_directory"`
	RepositorySHA256    string                                 `json:"repository_sha256"`
}

type journalBackend interface {
	publicationjournal.Store
	Reference() (awsbroker.PublicationEvidenceReference, error)
	ArchiveEvidence(context.Context, []byte, string) (awsbroker.PublicationEvidenceReference, error)
	ArchiveGeneration(context.Context, string, string) (awsbroker.PublicationEvidenceReference, error)
}
type journalFactory func(context.Context, awsbroker.PublicationJournalOperatorConfig) (journalBackend, error)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	if err := run(ctx, os.Args[1:], os.Stdout, newAWSJournal, time.Now); err != nil {
		// Underlying provider errors may contain caller data. Keep logs bounded
		// and value-free; immutable state is the recovery source of truth.
		fmt.Fprintln(os.Stderr, "hid-tuf-journal: rejected or unresolved; inspect protected journal evidence before retry")
		os.Exit(1)
	}
}

func run(ctx context.Context, args []string, output io.Writer, factory journalFactory, clock func() time.Time) error {
	if len(args) != 3 {
		return errors.New("usage: hid-tuf-journal ABSOLUTE_CONFIG EXPECTED_CONFIG_SHA256 ABSOLUTE_REQUEST")
	}
	data, err := repository.ReadOperatorConfigFile(args[0])
	if err != nil {
		return err
	}
	sum := sha256.Sum256(data)
	if hex.EncodeToString(sum[:]) != args[1] {
		return errors.New("journal config differs from protected pin")
	}
	config, err := awsbroker.DecodePublicationJournalOperatorConfig(data)
	if err != nil {
		return err
	}
	data, err = repository.ReadOperatorConfigFile(args[2])
	if err != nil {
		return err
	}
	var request journalRequest
	if err := strictjson.Decode(data, &request); err != nil {
		return err
	}
	// Reject unsupported operations before AWS initialization; there is no
	// reset/delete/steal/retry/resume capability in this command.
	switch request.Action {
	case "begin", "advance", "confirm", "fail", "read", "evidence", "archive":
	default:
		return errors.New("unsupported journal action")
	}
	backend, err := factory(ctx, config)
	if err != nil {
		return err
	}
	controller, err := publicationjournal.New(config.Policy(), backend, clock)
	if err != nil {
		return err
	}
	if request.Action == "evidence" {
		ref, err := backend.ArchiveEvidence(ctx, request.Evidence, request.EvidenceHash)
		if err != nil {
			return err
		}
		return json.NewEncoder(output).Encode(ref)
	}
	if request.Action == "archive" {
		ref, err := backend.ArchiveGeneration(ctx, request.RepositoryDirectory, request.RepositorySHA256)
		if err != nil {
			return err
		}
		return json.NewEncoder(output).Encode(ref)
	}
	var record publicationjournal.Record
	key := "hid-" + config.Reader.Environment + "-publication-v1"
	switch request.Action {
	case "begin":
		record, err = controller.Begin(ctx, request.Binding)
	case "advance":
		record, err = controller.Advance(ctx, request.Owner, request.Revision, request.Phase, request.EvidenceHash, request.Authorization)
	case "confirm":
		record, err = controller.Confirm(ctx, request.Owner, request.Revision, request.Confirmation, request.EvidenceHash)
	case "fail":
		record, err = controller.RecordFailure(ctx, request.Owner, request.Revision, request.FailureCode, request.EvidenceHash)
	case "read":
		record, err = backend.Load(ctx, key)
	}
	if err != nil {
		return err
	}
	readback, err := backend.Load(ctx, key)
	if err != nil {
		return err
	}
	if readback != record {
		return publicationjournal.ErrConflict
	}
	ref, err := backend.Reference()
	if err != nil {
		return err
	}
	return json.NewEncoder(output).Encode(struct {
		SchemaVersion string                                 `json:"schema_version"`
		Record        publicationjournal.Record              `json:"record"`
		Reference     awsbroker.PublicationEvidenceReference `json:"reference"`
	}{"hid.tuf.publication-journal-result/v1", record, ref})
}

func newAWSJournal(ctx context.Context, config awsbroker.PublicationJournalOperatorConfig) (journalBackend, error) {
	loaded, err := awsconfig.LoadDefaultConfig(ctx, awsconfig.WithRegion(config.Reader.ExpectedAWSRegion))
	if err != nil {
		return nil, err
	}
	client := &http.Client{Timeout: 30 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return errors.New("journal redirects are forbidden") }}
	// Do not inherit endpoints, middleware, custom CA or shared-config options.
	// Exactly one SDK attempt prevents transparent mutation replay after a lost
	// response. All service endpoints come from the SDK's regional resolver.
	fixed := aws.Config{Region: config.Reader.ExpectedAWSRegion, Credentials: loaded.Credentials, HTTPClient: client, RetryMaxAttempts: 1}
	return awsbroker.NewPublicationJournalStore(config.Storage(), s3.NewFromConfig(fixed), dynamodb.NewFromConfig(fixed), time.Now)
}
