package gateway

import (
	"bytes"
	"context"
	"errors"
	"io"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/smithy-go"
)

var ErrMiss = errors.New("cache miss")

const MaxImageBytes = 32 << 20

type Store interface {
	Get(context.Context, string) (*CachedObject, error)
	Put(context.Context, string, []byte) error
}
type S3Store struct {
	Client *s3.Client
	Bucket string
	Prefix string
}

type CachedObject struct {
	Body    io.ReadCloser
	Size    int64
	Created time.Time
}

func (s *S3Store) Get(ctx context.Context, key string) (*CachedObject, error) {
	out, err := s.Client.GetObject(ctx, &s3.GetObjectInput{Bucket: aws.String(s.Bucket), Key: aws.String(s.Prefix + key + ".jpg")})
	if err != nil {
		var api smithy.APIError
		if errors.As(err, &api) && (api.ErrorCode() == "NoSuchKey" || api.ErrorCode() == "NotFound") {
			return nil, ErrMiss
		}
		return nil, err
	}
	if out.LastModified == nil || out.ContentLength == nil || *out.ContentLength < 3 || *out.ContentLength > MaxImageBytes {
		out.Body.Close()
		return nil, errors.New("invalid cached object metadata")
	}
	return &CachedObject{Body: out.Body, Size: *out.ContentLength, Created: *out.LastModified}, nil
}
func (s *S3Store) Put(ctx context.Context, key string, data []byte) error {
	_, err := s.Client.PutObject(ctx, &s3.PutObjectInput{Bucket: aws.String(s.Bucket), Key: aws.String(s.Prefix + key + ".jpg"), Body: bytes.NewReader(data), ContentType: aws.String("image/jpeg"), CacheControl: aws.String("private, max-age=86400")})
	return err
}
