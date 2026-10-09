// Package strictjson decodes security-sensitive JSON without accepting
// duplicate object names, unknown fields, or trailing values.
package strictjson

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
)

// Decode rejects duplicate object member names at every nesting level before
// decoding into destination with unknown-field rejection enabled.
func Decode(data []byte, destination any) error {
	if err := rejectDuplicateNames(data); err != nil {
		return err
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		return err
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return errors.New("JSON contains a trailing value")
	}
	return nil
}

func rejectDuplicateNames(data []byte) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	if err := scanValue(decoder, "$", 0); err != nil {
		return err
	}
	if token, err := decoder.Token(); !errors.Is(err, io.EOF) {
		if err != nil {
			return err
		}
		return fmt.Errorf("JSON contains trailing token %v", token)
	}
	return nil
}

func scanValue(decoder *json.Decoder, location string, depth int) error {
	if depth > 128 {
		return errors.New("JSON nesting exceeds 128 levels")
	}
	token, err := decoder.Token()
	if err != nil {
		return err
	}
	delimiter, ok := token.(json.Delim)
	if !ok {
		return nil
	}
	switch delimiter {
	case '{':
		seen := make(map[string]struct{})
		for decoder.More() {
			nameToken, err := decoder.Token()
			if err != nil {
				return err
			}
			name, ok := nameToken.(string)
			if !ok {
				return fmt.Errorf("object name at %s is not a string", location)
			}
			if _, exists := seen[name]; exists {
				return fmt.Errorf("duplicate object name %q at %s", name, location)
			}
			seen[name] = struct{}{}
			if err := scanValue(decoder, location+"."+name, depth+1); err != nil {
				return err
			}
		}
		closing, err := decoder.Token()
		if err != nil {
			return err
		}
		if closing != json.Delim('}') {
			return fmt.Errorf("object at %s is not closed", location)
		}
	case '[':
		index := 0
		for decoder.More() {
			if err := scanValue(decoder, fmt.Sprintf("%s[%d]", location, index), depth+1); err != nil {
				return err
			}
			index++
		}
		closing, err := decoder.Token()
		if err != nil {
			return err
		}
		if closing != json.Delim(']') {
			return fmt.Errorf("array at %s is not closed", location)
		}
	default:
		return fmt.Errorf("unexpected JSON delimiter %q at %s", delimiter, location)
	}
	return nil
}
