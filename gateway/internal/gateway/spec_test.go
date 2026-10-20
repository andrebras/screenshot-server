package gateway

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"strings"
	"testing"
)

func signed(query string) string {
	mac := hmac.New(sha256.New, []byte("test-key"))
	mac.Write([]byte(query))
	return query + "&s=" + hex.EncodeToString(mac.Sum(nil))
}
func query(src string) string { return "src=" + formEncode(src) }
func TestSignatureAndIdentity(t *testing.T) {
	// These characters distinguish URLSearchParams from Go's default query encoder.
	raw := "src=https%3A%2F%2Fexample.com%2F%3Ftext%3D%7E*%2520%26label%3Dcaf%C3%A9&note=a+b"
	spec, key, err := Parse(signed(raw), "test-key", "v1", nil)
	if err != nil || spec.Src != "https://example.com/?text=~*%20&label=café" {
		t.Fatalf("%+v %v", spec, err)
	}
	other := "note=a+b&" + strings.Split(raw, "&note=")[0]
	_, reordered, err := Parse(signed(other), "test-key", "v1", nil)
	if err != nil || key != reordered {
		t.Fatal("equivalent signed ordering changed cache identity", err)
	}
	for _, suffix := range []string{"&ts=2", "&gId=3", "&viewportWidth=600&viewportHeight=800"} {
		_, changed, e := Parse(signed(raw+suffix), "test-key", "v1", nil)
		if e != nil || changed == key {
			t.Fatal("render dependency omitted from identity", suffix, e)
		}
	}
	_, changed, _ := Parse(signed(raw), "test-key", "v2", nil)
	if changed == key {
		t.Fatal("renderer version omitted")
	}
	// Existing Node verification normalizes the unsigned form before verifying it.
	normalized := signed("src=https%3A%2F%2Fexample.com%2F&label=%7E*+a")
	unnormalized := strings.Replace(normalized, "label=%7E*+a", "label=~*%20a", 1)
	if _, _, e := Parse(unnormalized, "test-key", "v1", nil); e != nil {
		t.Fatal(e)
	}
}
func TestRefusals(t *testing.T) {
	base := query("https://example.com/")
	for _, raw := range []string{
		"", base, signed(base) + "x", signed(base) + "&s=x", signed(base + "&src=other"), signed(base + "&s=foo"),
		signed(query("file:///etc/passwd")), signed(query("http://")), signed(query("https://example.com/" + strings.Repeat("x", 2048))),
		signed(base + "&width=100"), signed(base + "&height=100"), signed(base + "&x=0"), signed(base + "&maxHeight=100"),
		signed(base + "&viewportWidth=100"), signed(base + "&viewportWidth=0&viewportHeight=100"),
		signed(base + "&width=4096&height=10001"), signed(base + "&width=1.5&height=1"),
		signed(base + "&width=1e3&height=1"), signed(base + "&width=2&height=2&width=3"),
		signed(base + "&x=-1&width=2&height=2"), signed(base + "&width=99999999999999999999999999999&height=1"),
	} {
		if _, _, err := Parse(raw, "test-key", "v1", nil); err == nil {
			t.Errorf("accepted %s", raw)
		}
	}
	if _, _, e := Parse(signed(base), "wrong-key", "v1", nil); e == nil {
		t.Fatal("accepted wrong key")
	}
}
func TestClipAndTrustedReadiness(t *testing.T) {
	raw := query("https://reader.example/dynamic_pages/1/2/at1200") + "&width=20000&height=1000"
	spec, defaultKey, e := Parse(signed(raw), "test-key", "v1", nil)
	if e != nil || spec.Width != 20000 || spec.Readiness != "networkidle0" {
		t.Fatal(spec, e)
	}
	spec, fastKey, e := Parse(signed(raw), "test-key", "v1", map[string]bool{"reader.example": true})
	if e != nil || spec.Readiness != "assets" || fastKey == defaultKey {
		t.Fatal(spec, e)
	}
	for _, src := range []string{"https://external.example/dynamic_pages/1/2/at1200", "https://reader.example/arbitrary"} {
		spec, _, e := Parse(signed(query(src)), "test-key", "v1", map[string]bool{"reader.example": true})
		if e != nil || spec.Readiness != "networkidle0" {
			t.Fatal(spec, e)
		}
	}
}

func TestNodeGeneratedSignatures(t *testing.T) {
	data, err := os.ReadFile("testdata/legacy-signatures.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixtures []struct {
		Src   string
		Query string
	}
	if err = json.Unmarshal(data, &fixtures); err != nil {
		t.Fatal(err)
	}
	for _, f := range fixtures {
		spec, _, err := Parse(f.Query, "test-key", "v1", nil)
		if err != nil || spec.Src != f.Src {
			t.Fatal(spec, err)
		}
	}
}
