package strictjson

import "testing"

func TestDecodeRejectsDuplicateUnknownAndTrailingData(t *testing.T) {
	t.Parallel()
	type document struct {
		Name string `json:"name"`
	}
	for _, input := range []string{
		`{"name":"first","name":"second"}`,
		`{"name":"valid","extra":true}`,
		`{"name":"valid"}{"name":"trailing"}`,
		`{"name":"valid"} trailing`,
	} {
		var decoded document
		if err := Decode([]byte(input), &decoded); err == nil {
			t.Fatalf("accepted non-strict JSON %q", input)
		}
	}
	var decoded document
	if err := Decode([]byte(`{"name":"valid"}`), &decoded); err != nil {
		t.Fatal(err)
	}
}

func TestDecodeRejectsNestedDuplicate(t *testing.T) {
	t.Parallel()
	var decoded struct {
		Nested map[string]any `json:"nested"`
	}
	if err := Decode([]byte(`{"nested":{"key":1,"key":2}}`), &decoded); err == nil {
		t.Fatal("accepted nested duplicate object name")
	}
}
