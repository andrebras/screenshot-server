package gateway

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

type Spec struct {
	Src            string `json:"src"`
	ViewportWidth  int    `json:"viewportWidth,omitempty"`
	ViewportHeight int    `json:"viewportHeight,omitempty"`
	MaxHeight      int    `json:"maxHeight,omitempty"`
	X              int    `json:"x,omitempty"`
	Y              int    `json:"y,omitempty"`
	Width          int    `json:"width,omitempty"`
	Height         int    `json:"height,omitempty"`
	Readiness      string `json:"readiness"`
}

var integer = regexp.MustCompile(`^-?\d+$`)

// URLSearchParams uses application/x-www-form-urlencoded, including escaping ~ and keeping *.
func formEncode(s string) string {
	const digits = "0123456789ABCDEF"
	var out strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9', strings.ContainsRune("*-._", rune(c)):
			out.WriteByte(c)
		case c == ' ':
			out.WriteByte('+')
		default:
			out.WriteByte('%')
			out.WriteByte(digits[c>>4])
			out.WriteByte(digits[c&15])
		}
	}
	return out.String()
}

func Parse(raw, secret, version string, trustedHosts map[string]bool) (Spec, string, error) {
	var spec Spec
	if len(raw) > 16384 {
		return spec, "", errors.New("query too long")
	}
	unsigned, signature, ok := strings.Cut(raw, "&s=")
	if !ok || len(signature) != 64 {
		return spec, "", errors.New("invalid signature")
	}
	params := map[string]string{}
	var canonical []string
	for _, part := range strings.Split(unsigned, "&") {
		if part == "" {
			continue
		}
		key, value, _ := strings.Cut(part, "=")
		key, e := url.QueryUnescape(key)
		if e != nil {
			return spec, "", errors.New("invalid query")
		}
		value, e = url.QueryUnescape(value)
		if e != nil {
			return spec, "", errors.New("invalid query")
		}
		if _, exists := params[key]; exists || key == "s" {
			return spec, "", errors.New("duplicate parameter")
		}
		params[key] = value
		canonical = append(canonical, formEncode(key)+"="+formEncode(value))
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(strings.Join(canonical, "&")))
	supplied, err := hex.DecodeString(signature)
	if err != nil || !hmac.Equal(mac.Sum(nil), supplied) {
		return spec, "", errors.New("invalid signature")
	}
	spec.Src = params["src"]
	u, err := url.Parse(spec.Src)
	if err != nil || u.Hostname() == "" || (u.Scheme != "http" && u.Scheme != "https") || len(spec.Src) > 2048 {
		return spec, "", errors.New("src must be an http or https URL of at most 2048 characters")
	}
	targets := map[string]*int{"viewportWidth": &spec.ViewportWidth, "viewportHeight": &spec.ViewportHeight, "maxHeight": &spec.MaxHeight, "x": &spec.X, "y": &spec.Y, "width": &spec.Width, "height": &spec.Height}
	limits := map[string]int{"viewportWidth": 4096, "viewportHeight": 10000, "maxHeight": 10000, "x": 4095, "y": 9999, "width": 65500, "height": 65500}
	for key, target := range targets {
		if value, exists := params[key]; exists {
			n, e := strconv.Atoi(value)
			min := 1
			if key == "x" || key == "y" {
				min = 0
			}
			if !integer.MatchString(value) || e != nil || n < min || n > limits[key] {
				return spec, "", fmt.Errorf("invalid %s", key)
			}
			*target = n
		}
	}
	has := func(k string) bool { _, ok := params[k]; return ok }
	if has("viewportWidth") != has("viewportHeight") || has("width") != has("height") || ((has("x") || has("y")) && !has("width")) || (has("maxHeight") && !has("viewportWidth")) || int64(spec.Width)*int64(spec.Height) > 4096*10000 {
		return spec, "", errors.New("incomplete or oversized render dimensions")
	}
	spec.Readiness = "networkidle0"
	if trustedHosts[strings.ToLower(u.Hostname())] && (strings.HasPrefix(u.Path, "/dynamic_pages/") || strings.HasPrefix(u.Path, "/adaptive_pages/") || strings.HasPrefix(u.Path, "/content_templates/")) {
		spec.Readiness = "assets"
	}
	// Keep every signed parameter: version stamps, tenant IDs and future render options cannot alias.
	keys := make([]string, 0, len(params))
	for key := range params {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	identity := []string{version, spec.Readiness}
	for _, key := range keys {
		identity = append(identity, key, params[key])
	}
	encoded, _ := json.Marshal(identity)
	sum := sha256.Sum256(encoded)
	return spec, hex.EncodeToString(sum[:]), nil
}
