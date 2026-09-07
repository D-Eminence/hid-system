package awsbroker

import (
	"context"
	"errors"
	"time"

	"github.com/D-Eminence/hid-system/tools/tuf-release/internal/publicationjournal"
	"github.com/D-Eminence/hid-system/tools/tuf-release/internal/strictjson"
)

// This non-secret file is installed by the protected publisher configuration,
// separately from candidate artifacts, and pinned by its exact SHA-256.
type PublicationJournalOperatorConfig struct {
	SchemaVersion          string                  `json:"schema_version"`
	Reader                 PublicationReaderConfig `json:"reader"`
	GitHubRepository       string                  `json:"github_repository"`
	WorkflowRef            string                  `json:"workflow_ref"`
	HistoricalWorkflowRefs []string                `json:"historical_workflow_refs"`
}

func DecodePublicationJournalOperatorConfig(data []byte) (PublicationJournalOperatorConfig, error) {
	var config PublicationJournalOperatorConfig
	if len(data) == 0 || len(data) > 64000 {
		return config, errors.New("publication journal config exceeds its bound")
	}
	if err := strictjson.Decode(data, &config); err != nil {
		return config, err
	}
	if config.SchemaVersion != "hid.tuf.publication-journal-operator/v1" {
		return config, errors.New("publication journal operator schema is invalid")
	}
	if err := validatePublicationReaderConfig(config.Reader, time.Now); err != nil {
		return config, err
	}
	if _, err := publicationjournal.New(config.Policy(), journalConfigValidationStore{}, time.Now); err != nil {
		return config, err
	}
	return config, nil
}

type journalConfigValidationStore struct{}

func (journalConfigValidationStore) Load(context.Context, string) (publicationjournal.Record, error) {
	return publicationjournal.Record{}, errors.New("configuration validation cannot read state")
}
func (journalConfigValidationStore) CompareAndSwap(context.Context, string, int64, publicationjournal.Record) error {
	return errors.New("configuration validation cannot write state")
}

func (config PublicationJournalOperatorConfig) Policy() publicationjournal.Config {
	return publicationjournal.Config{Environment: config.Reader.Environment, RepositoryID: config.Reader.RepositoryID,
		StateID: config.Reader.StateID, BootstrapRootSHA256: config.Reader.BootstrapRootSHA256,
		GitHubRepository: config.GitHubRepository, WorkflowRef: config.WorkflowRef,
		HistoricalWorkflowRefs: config.HistoricalWorkflowRefs}
}

func (config PublicationJournalOperatorConfig) Storage() PublicationJournalConfig {
	return PublicationJournalConfig{Policy: config.Policy(), TableName: config.Reader.TableName,
		BucketName: config.Reader.BucketName, ObjectPrefix: "tuf-publication-journal/hid-" + config.Reader.Environment + "-publication-v1/",
		ExpectedBucketOwner: config.Reader.ExpectedAWSAccountID, EncryptionKeyARN: config.Reader.EncryptionKeyARN,
		ObjectLockMode: config.Reader.ObjectLockMode}
}
