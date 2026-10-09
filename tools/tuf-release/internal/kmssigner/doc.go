// Package kmssigner adapts one pinned AWS KMS asymmetric signing key to the
// Sigstore signature.Signer interface consumed by go-tuf metadata.Sign.
//
// The adapter deliberately supports only an immutable KMS key ARN for an
// ECC_NIST_P256 SIGN_VERIFY key and ECDSA_SHA_256. It exports no signing CLI,
// handles no private key bytes, and verifies every KMS signature locally with
// the public key pinned when the signer is constructed.
package kmssigner
