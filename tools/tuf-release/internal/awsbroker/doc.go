// Package awsbroker provides the AWS runtime adapters for the HID TUF
// signing broker. Durable checkpoint bodies live in immutable, versioned,
// Object-Locked S3 objects; DynamoDB contains only the small CAS manifest.
//
// The package accepts narrow client interfaces so its security policy can be
// exercised without credentials or network access.
package awsbroker
