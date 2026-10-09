package kmssigner

import (
	"bytes"
	"context"
	"crypto"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/sha256"
	"crypto/subtle"
	"crypto/x509"
	"encoding/asn1"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"math/big"
	"reflect"
	"regexp"

	"github.com/aws/aws-sdk-go-v2/service/kms"
	"github.com/aws/aws-sdk-go-v2/service/kms/types"
	"github.com/sigstore/sigstore/pkg/signature"
	signatureoptions "github.com/sigstore/sigstore/pkg/signature/options"
)

var (
	// ErrInvalidConfiguration identifies a signer configuration that is not
	// precise enough to bind an immutable P-256 KMS key.
	ErrInvalidConfiguration = errors.New("invalid KMS signer configuration")
	// ErrInvalidKMSResponse identifies a successful KMS RPC whose response does
	// not exactly match the configured key and algorithm contract.
	ErrInvalidKMSResponse = errors.New("invalid KMS response")
	// ErrSignatureVerification identifies a KMS signature that is malformed or
	// does not verify under the public key returned during construction.
	ErrSignatureVerification = errors.New("KMS signature verification failed")

	keyARNPattern = regexp.MustCompile(`^arn:(?:aws|aws-us-gov|aws-cn|aws-iso|aws-iso-b):kms:[a-z0-9-]{3,32}:[0-9]{12}:key/(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|mrk-[0-9a-f]{32})$`)
	sha256Pattern = regexp.MustCompile(`^[0-9a-f]{64}$`)
)

// Client is the smallest AWS SDK v2 KMS surface required by Signer. A real
// *kms.Client implements it; tests can use a local fake without credentials or
// network access.
type Client interface {
	GetPublicKey(context.Context, *kms.GetPublicKeyInput, ...func(*kms.Options)) (*kms.GetPublicKeyOutput, error)
	Sign(context.Context, *kms.SignInput, ...func(*kms.Options)) (*kms.SignOutput, error)
}

// Config pins both the immutable KMS key ARN and the SHA-256 of its exact DER
// SubjectPublicKeyInfo. Alias ARNs and bare key IDs are intentionally rejected.
type Config struct {
	KeyARN               string
	PublicKeyDERChecksum string
}

// Signer implements signature.Signer for one pinned AWS KMS P-256 key.
// Signer is safe for concurrent use when its Client is safe for concurrent use,
// as *kms.Client is.
type Signer struct {
	client    Client
	context   context.Context
	keyARN    string
	publicKey *ecdsa.PublicKey
}

var _ signature.Signer = (*Signer)(nil)
var _ Client = (*kms.Client)(nil)

// New retrieves and validates the configured public key once. It performs no
// signing and creates or imports no key material.
func New(ctx context.Context, client Client, config Config) (*Signer, error) {
	if isNil(ctx) {
		return nil, fmt.Errorf("%w: context is nil", ErrInvalidConfiguration)
	}
	if isNil(client) {
		return nil, fmt.Errorf("%w: KMS client is nil", ErrInvalidConfiguration)
	}
	if !keyARNPattern.MatchString(config.KeyARN) {
		return nil, fmt.Errorf("%w: key ARN must identify an immutable KMS key", ErrInvalidConfiguration)
	}
	if !sha256Pattern.MatchString(config.PublicKeyDERChecksum) {
		return nil, fmt.Errorf("%w: public-key checksum must be lowercase SHA-256", ErrInvalidConfiguration)
	}
	expectedChecksum, err := hex.DecodeString(config.PublicKeyDERChecksum)
	if err != nil { // Guarded by the exact pattern; retain fail-closed parsing.
		return nil, fmt.Errorf("%w: malformed public-key checksum", ErrInvalidConfiguration)
	}
	if err := ctx.Err(); err != nil {
		return nil, fmt.Errorf("get KMS public key: %w", err)
	}

	keyARN := config.KeyARN
	output, err := client.GetPublicKey(ctx, &kms.GetPublicKeyInput{KeyId: &keyARN})
	if err != nil {
		return nil, fmt.Errorf("get KMS public key: %w", err)
	}
	publicKey, err := validatePublicKeyResponse(output, config.KeyARN, expectedChecksum)
	if err != nil {
		return nil, err
	}
	return &Signer{
		client: client, context: ctx, keyARN: config.KeyARN, publicKey: publicKey,
	}, nil
}

// PublicKey returns an independent copy so callers cannot mutate the key used
// for post-sign verification. Only the standard context RPC option is honored;
// key-version, remote-verification, and RPC-auth overrides are rejected.
func (s *Signer) PublicKey(opts ...signature.PublicKeyOption) (crypto.PublicKey, error) {
	if s == nil || s.publicKey == nil {
		return nil, fmt.Errorf("%w: signer is uninitialized", ErrInvalidConfiguration)
	}
	ctx, err := publicKeyContext(s.context, opts)
	if err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	return clonePublicKey(s.publicKey), nil
}

// SignMessage hashes the complete message locally with SHA-256, asks KMS to
// sign exactly that digest, strictly parses the returned ASN.1 DER pair, and
// verifies it locally before returning a copy to the caller.
func (s *Signer) SignMessage(message io.Reader, opts ...signature.SignOption) ([]byte, error) {
	if s == nil || s.publicKey == nil || isNil(s.client) {
		return nil, fmt.Errorf("%w: signer is uninitialized", ErrInvalidConfiguration)
	}
	if isNil(message) {
		return nil, errors.New("message reader is nil")
	}
	ctx, err := signContext(s.context, opts)
	if err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	hasher := sha256.New()
	if _, err := io.Copy(hasher, message); err != nil {
		return nil, fmt.Errorf("hash message: %w", err)
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	digest := hasher.Sum(nil)
	keyARN := s.keyARN
	output, err := s.client.Sign(ctx, &kms.SignInput{
		KeyId:            &keyARN,
		Message:          digest,
		MessageType:      types.MessageTypeDigest,
		SigningAlgorithm: types.SigningAlgorithmSpecEcdsaSha256,
	})
	if err != nil {
		return nil, fmt.Errorf("KMS sign: %w", err)
	}
	signatureBytes, err := validateSignatureResponse(output, s.keyARN, s.publicKey, digest)
	if err != nil {
		return nil, err
	}
	return signatureBytes, nil
}

func validatePublicKeyResponse(output *kms.GetPublicKeyOutput, keyARN string, expectedChecksum []byte) (*ecdsa.PublicKey, error) {
	if output == nil {
		return nil, fmt.Errorf("%w: GetPublicKey returned nil output", ErrInvalidKMSResponse)
	}
	if output.KeyId == nil || *output.KeyId != keyARN {
		return nil, fmt.Errorf("%w: GetPublicKey key ID did not match", ErrInvalidKMSResponse)
	}
	if output.KeySpec != types.KeySpecEccNistP256 {
		return nil, fmt.Errorf("%w: GetPublicKey key spec is not ECC_NIST_P256", ErrInvalidKMSResponse)
	}
	if output.CustomerMasterKeySpec != "" && output.CustomerMasterKeySpec != types.CustomerMasterKeySpecEccNistP256 {
		return nil, fmt.Errorf("%w: GetPublicKey deprecated key spec conflicts", ErrInvalidKMSResponse)
	}
	if output.KeyUsage != types.KeyUsageTypeSignVerify {
		return nil, fmt.Errorf("%w: GetPublicKey usage is not SIGN_VERIFY", ErrInvalidKMSResponse)
	}
	if len(output.SigningAlgorithms) != 1 || output.SigningAlgorithms[0] != types.SigningAlgorithmSpecEcdsaSha256 {
		return nil, fmt.Errorf("%w: GetPublicKey signing algorithms are not exactly ECDSA_SHA_256", ErrInvalidKMSResponse)
	}
	if len(output.EncryptionAlgorithms) != 0 || len(output.KeyAgreementAlgorithms) != 0 {
		return nil, fmt.Errorf("%w: GetPublicKey returned conflicting algorithms", ErrInvalidKMSResponse)
	}
	if len(output.PublicKey) == 0 {
		return nil, fmt.Errorf("%w: GetPublicKey omitted public key", ErrInvalidKMSResponse)
	}
	der := bytes.Clone(output.PublicKey)
	checksum := sha256.Sum256(der)
	if len(expectedChecksum) != sha256.Size || subtle.ConstantTimeCompare(checksum[:], expectedChecksum) != 1 {
		return nil, fmt.Errorf("%w: GetPublicKey public-key checksum did not match", ErrInvalidKMSResponse)
	}
	parsed, err := x509.ParsePKIXPublicKey(der)
	if err != nil {
		return nil, fmt.Errorf("%w: invalid SubjectPublicKeyInfo", ErrInvalidKMSResponse)
	}
	publicKey, ok := parsed.(*ecdsa.PublicKey)
	if !ok || publicKey.Curve != elliptic.P256() || publicKey.X == nil || publicKey.Y == nil ||
		!elliptic.P256().IsOnCurve(publicKey.X, publicKey.Y) {
		return nil, fmt.Errorf("%w: public key is not a valid P-256 ECDSA key", ErrInvalidKMSResponse)
	}
	canonicalDER, err := x509.MarshalPKIXPublicKey(publicKey)
	if err != nil || !bytes.Equal(canonicalDER, der) {
		return nil, fmt.Errorf("%w: public key is not canonical DER", ErrInvalidKMSResponse)
	}
	return clonePublicKey(publicKey), nil
}

func validateSignatureResponse(output *kms.SignOutput, keyARN string, publicKey *ecdsa.PublicKey, digest []byte) ([]byte, error) {
	if output == nil {
		return nil, fmt.Errorf("%w: Sign returned nil output", ErrInvalidKMSResponse)
	}
	if output.KeyId == nil || *output.KeyId != keyARN {
		return nil, fmt.Errorf("%w: Sign key ID did not match", ErrInvalidKMSResponse)
	}
	if output.SigningAlgorithm != types.SigningAlgorithmSpecEcdsaSha256 {
		return nil, fmt.Errorf("%w: Sign algorithm is not ECDSA_SHA_256", ErrInvalidKMSResponse)
	}
	signatureBytes := bytes.Clone(output.Signature)
	if err := validateDERSignature(signatureBytes, publicKey.Params().N); err != nil {
		return nil, fmt.Errorf("%w: %v", ErrSignatureVerification, err)
	}
	if len(digest) != sha256.Size || !ecdsa.VerifyASN1(publicKey, digest, signatureBytes) {
		return nil, fmt.Errorf("%w: signature did not verify locally", ErrSignatureVerification)
	}
	return signatureBytes, nil
}

type ecdsaSignature struct {
	R *big.Int
	S *big.Int
}

func validateDERSignature(encoded []byte, order *big.Int) error {
	if len(encoded) == 0 {
		return errors.New("signature is empty")
	}
	var decoded ecdsaSignature
	rest, err := asn1.Unmarshal(encoded, &decoded)
	if err != nil || len(rest) != 0 || decoded.R == nil || decoded.S == nil {
		return errors.New("signature is not one complete DER ECDSA pair")
	}
	if decoded.R.Sign() <= 0 || decoded.S.Sign() <= 0 || decoded.R.Cmp(order) >= 0 || decoded.S.Cmp(order) >= 0 {
		return errors.New("signature scalars are outside the P-256 range")
	}
	canonical, err := asn1.Marshal(decoded)
	if err != nil || !bytes.Equal(canonical, encoded) {
		return errors.New("signature is not canonical DER")
	}
	return nil
}

func publicKeyContext(base context.Context, opts []signature.PublicKeyOption) (context.Context, error) {
	ctx := base
	for _, option := range opts {
		if isNil(option) {
			return nil, errors.New("nil public-key option")
		}
		remoteVerification := false
		auth := signatureoptions.RPCAuth{}
		keyVersion := ""
		option.ApplyContext(&ctx)
		option.ApplyRemoteVerification(&remoteVerification)
		option.ApplyRPCAuthOpts(&auth)
		option.ApplyKeyVersion(&keyVersion)
		if remoteVerification || auth != (signatureoptions.RPCAuth{}) || keyVersion != "" {
			return nil, errors.New("unsupported public-key option")
		}
	}
	if isNil(ctx) {
		return nil, errors.New("public-key context is nil")
	}
	return ctx, nil
}

func signContext(base context.Context, opts []signature.SignOption) (context.Context, error) {
	ctx := base
	for _, option := range opts {
		if isNil(option) {
			return nil, errors.New("nil sign option")
		}
		remoteVerification := false
		auth := signatureoptions.RPCAuth{}
		keyVersion := ""
		var digest []byte
		var signerOpts crypto.SignerOpts
		var random io.Reader
		var keyVersionUsed *string
		option.ApplyContext(&ctx)
		option.ApplyRemoteVerification(&remoteVerification)
		option.ApplyRPCAuthOpts(&auth)
		option.ApplyKeyVersion(&keyVersion)
		option.ApplyDigest(&digest)
		option.ApplyCryptoSignerOpts(&signerOpts)
		option.ApplyRand(&random)
		option.ApplyKeyVersionUsed(&keyVersionUsed)
		if remoteVerification || auth != (signatureoptions.RPCAuth{}) || keyVersion != "" ||
			digest != nil || signerOpts != nil || random != nil || keyVersionUsed != nil {
			return nil, errors.New("unsupported sign option")
		}
	}
	if isNil(ctx) {
		return nil, errors.New("sign context is nil")
	}
	return ctx, nil
}

func clonePublicKey(publicKey *ecdsa.PublicKey) *ecdsa.PublicKey {
	return &ecdsa.PublicKey{
		Curve: publicKey.Curve,
		X:     new(big.Int).Set(publicKey.X),
		Y:     new(big.Int).Set(publicKey.Y),
	}
}

func isNil(value any) bool {
	if value == nil {
		return true
	}
	reflected := reflect.ValueOf(value)
	switch reflected.Kind() {
	case reflect.Chan, reflect.Func, reflect.Interface, reflect.Map, reflect.Pointer, reflect.Slice:
		return reflected.IsNil()
	default:
		return false
	}
}
