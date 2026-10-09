package repository

import (
	"errors"
	"fmt"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/D-Eminence/hid-system/tools/tuf-release/internal/strictjson"
)

const (
	SchemaVersion        = "1.0.0"
	MaxTargetBytes int64 = 25 << 20
	MaxTargets           = 512
	MaxPlanBytes   int64 = 1 << 20
)

var (
	repositoryIDPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,63}$`)
	releaseIDPattern    = regexp.MustCompile(`^r[0-9]{10}-g[0-9a-f]{40}$`)
	sha256Pattern       = regexp.MustCompile(`^[0-9a-f]{64}$`)
	pathSegmentPattern  = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]*$`)
)

type TargetInput struct {
	Path       string `json:"path"`
	SourcePath string `json:"source_path"`
	Length     int64  `json:"length"`
	SHA256     string `json:"sha256"`
}

type TargetsPlan struct {
	SchemaVersion  string        `json:"schema_version"`
	Environment    string        `json:"environment"`
	RepositoryID   string        `json:"repository_id"`
	ReleaseID      string        `json:"release_id"`
	CreatedAt      string        `json:"created_at"`
	RootVersion    int64         `json:"root_version"`
	TargetsVersion int64         `json:"targets_version"`
	TargetsExpires string        `json:"targets_expires"`
	Targets        []TargetInput `json:"targets"`
}

type validatedPlan struct {
	Plan      TargetsPlan
	CreatedAt time.Time
	Expires   time.Time
}

func LoadTargetsPlan(path string) (TargetsPlan, error) {
	data, err := readRegularFile(path, MaxPlanBytes)
	if err != nil {
		return TargetsPlan{}, fmt.Errorf("read targets plan: %w", err)
	}
	var raw any
	if err := strictjson.Decode(data, &raw); err != nil {
		return TargetsPlan{}, fmt.Errorf("decode targets plan shape: %w", err)
	}
	object, err := exactObject(raw, "targets plan", "created_at", "environment", "release_id", "repository_id", "root_version", "schema_version", "targets", "targets_expires", "targets_version")
	if err != nil {
		return TargetsPlan{}, err
	}
	targets, ok := object["targets"].([]any)
	if !ok {
		return TargetsPlan{}, errors.New("targets plan targets must be an array")
	}
	for index, target := range targets {
		if _, err := exactObject(target, fmt.Sprintf("targets plan target %d", index), "length", "path", "sha256", "source_path"); err != nil {
			return TargetsPlan{}, err
		}
	}
	var plan TargetsPlan
	if err := strictjson.Decode(data, &plan); err != nil {
		return TargetsPlan{}, fmt.Errorf("decode targets plan: %w", err)
	}
	if _, err := validateTargetsPlan(plan); err != nil {
		return TargetsPlan{}, err
	}
	return plan, nil
}

func validateTargetsPlan(plan TargetsPlan) (validatedPlan, error) {
	if plan.SchemaVersion != SchemaVersion {
		return validatedPlan{}, fmt.Errorf("unsupported targets plan schema %q", plan.SchemaVersion)
	}
	if plan.Environment != "staging" && plan.Environment != "production" {
		return validatedPlan{}, errors.New("targets plan environment must be staging or production")
	}
	if !repositoryIDPattern.MatchString(plan.RepositoryID) {
		return validatedPlan{}, errors.New("targets plan repository ID is invalid")
	}
	if plan.RepositoryID != governedRepositoryID(plan.Environment) {
		return validatedPlan{}, errors.New("targets plan repository ID does not match its environment")
	}
	if !releaseIDPattern.MatchString(plan.ReleaseID) {
		return validatedPlan{}, errors.New("targets plan release ID is invalid")
	}
	if plan.RootVersion < 1 || plan.RootVersion > maxSafeInteger ||
		plan.TargetsVersion < 1 || plan.TargetsVersion > maxSafeInteger {
		return validatedPlan{}, errors.New("root and targets versions must be positive safe integers")
	}
	createdAt, err := parseWholeSecondUTC(plan.CreatedAt, "targets plan created_at")
	if err != nil {
		return validatedPlan{}, err
	}
	expires, err := parseWholeSecondUTC(plan.TargetsExpires, "targets plan targets_expires")
	if err != nil {
		return validatedPlan{}, err
	}
	lifetime := expires.Sub(createdAt)
	if lifetime < 14*24*time.Hour || lifetime > 90*24*time.Hour {
		return validatedPlan{}, errors.New("targets lifetime must be from 14 through 90 days")
	}
	if len(plan.Targets) == 0 || len(plan.Targets) > MaxTargets {
		return validatedPlan{}, fmt.Errorf("targets count is outside 1..%d", MaxTargets)
	}
	seen := make(map[string]struct{}, len(plan.Targets))
	previous := ""
	channelCount := 0
	releaseCount := 0
	for index, target := range plan.Targets {
		if err := validateLogicalTargetPath(target.Path, plan.Environment, plan.ReleaseID); err != nil {
			return validatedPlan{}, fmt.Errorf("target %d: %w", index, err)
		}
		if index > 0 && strings.Compare(previous, target.Path) >= 0 {
			return validatedPlan{}, errors.New("targets must be strictly sorted by logical path")
		}
		previous = target.Path
		if _, duplicate := seen[target.Path]; duplicate {
			return validatedPlan{}, fmt.Errorf("targets plan repeats %q", target.Path)
		}
		seen[target.Path] = struct{}{}
		if target.Path == "environments/"+plan.Environment+"/channels/current.json" {
			channelCount++
		} else {
			releaseCount++
		}
		if target.SourcePath == "" || strings.ContainsRune(target.SourcePath, 0) ||
			!filepath.IsAbs(target.SourcePath) || filepath.Clean(target.SourcePath) != target.SourcePath {
			return validatedPlan{}, fmt.Errorf("target %q source path must be canonical and absolute", target.Path)
		}
		if target.Length < 1 || target.Length > MaxTargetBytes {
			return validatedPlan{}, fmt.Errorf("target %q length is outside 1..%d", target.Path, MaxTargetBytes)
		}
		if !sha256Pattern.MatchString(target.SHA256) {
			return validatedPlan{}, fmt.Errorf("target %q SHA-256 is invalid", target.Path)
		}
	}
	if channelCount != 1 || releaseCount == 0 {
		return validatedPlan{}, errors.New("targets plan must contain exactly one current channel target and at least one immutable release target")
	}
	return validatedPlan{Plan: plan, CreatedAt: createdAt, Expires: expires}, nil
}

func governedRepositoryID(environment string) string {
	if environment == "staging" {
		return "hid-staging-v1"
	}
	if environment == "production" {
		return "hid-production-v1"
	}
	return ""
}

func validateLogicalTargetPath(value, environment, releaseID string) error {
	if value == "" || len(value) > 512 || strings.ContainsRune(value, 0) || strings.HasPrefix(value, "/") {
		return errors.New("logical target path is invalid")
	}
	segments := strings.Split(value, "/")
	for _, segment := range segments {
		if !pathSegmentPattern.MatchString(segment) {
			return errors.New("logical target path has a non-portable segment")
		}
	}
	channel := len(segments) == 4 && segments[0] == "environments" && segments[1] == environment &&
		segments[2] == "channels" && segments[3] == "current.json"
	release := len(segments) >= 5 && segments[0] == "environments" && segments[1] == environment &&
		segments[2] == "releases" && segments[3] == releaseID
	if !channel && !release {
		return errors.New("logical target is outside the selected release namespace")
	}
	return nil
}

func physicalTargetPath(logicalPath, sha256 string) string {
	segments := strings.Split(logicalPath, "/")
	name := segments[len(segments)-1]
	segments[len(segments)-1] = sha256 + "." + name
	return path.Join(append([]string{"targets"}, segments...)...)
}

func parseWholeSecondUTC(value, label string) (time.Time, error) {
	parsed, err := time.Parse("2006-01-02T15:04:05Z", value)
	if err != nil || parsed.Format("2006-01-02T15:04:05Z") != value {
		return time.Time{}, fmt.Errorf("%s must be a real whole-second UTC timestamp", label)
	}
	return parsed, nil
}

func sortedCopy(values []string) []string {
	result := append([]string(nil), values...)
	sort.Strings(result)
	return result
}
