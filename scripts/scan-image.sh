#!/usr/bin/env bash
# Scans a local image the way CI's scan does (ci.yml's smoke job and scan.yml):
# the same Grype version, .grype.yaml, and failure on High and Critical
# vulnerabilities that have a fix. Build the image first
# (`docker build -t node-effect-template:local .`), or name another image.
set -euo pipefail
cd "$(dirname "$0")/.."

# Pinned by digest, with the version of `grype-version` in the workflows:
# scripts/toolchain.test.ts fails when they differ. The comment lets Renovate
# update the tag and the digest together.
# renovate: datasource=docker depName=anchore/grype
grype_image=anchore/grype:v0.121.0@sha256:621d56d1d68106b787022c81546f7e0a36202a25d1239f0c20195fab8c16f7ea

image=${1:-node-effect-template:local}
archive_directory=$(mktemp -d)
trap 'rm -rf "$archive_directory"' EXIT

# Grype reads a saved copy of the image rather than the Docker socket, which
# would give its container control of the Docker daemon. It downloads the
# current vulnerability database on every run, as CI does.
docker save --output "$archive_directory/image.tar" "$image"
docker run --rm \
  --volume "$archive_directory/image.tar:/image.tar:ro" \
  --volume "$PWD/.grype.yaml:/.grype.yaml:ro" \
  "$grype_image" --config /.grype.yaml --only-fixed --fail-on high \
  --output table docker-archive:/image.tar
