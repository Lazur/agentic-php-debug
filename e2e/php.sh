#!/bin/sh
# Run a PHP fixture under Xdebug for the plan e2e tests.
#
# Uses the host's PHP when it has Xdebug loaded; otherwise runs the same script
# in a container that has it (default: ddev's webserver image, override with
# E2E_PHP_IMAGE). In the container the package root is mounted at /app, which
# the e2e plans map back with session.pathMappings {"/app": "${root}"}.
#
# The ddev image ships Xdebug disabled (ddev enables it at runtime), hence the
# explicit zend_extension; Xdebug also turns the JIT off with a warning, so it is
# disabled up front to keep the fixture's output clean.
#
# The runner injects XDEBUG_MODE, XDEBUG_TRIGGER and XDEBUG_CONFIG
# ("client_host=… client_port=…"); the container gets the same, pointed at the
# host.
set -e
ROOT=$(cd "$(dirname "$0")/.." && pwd)

if php -m 2>/dev/null | grep -qi '^xdebug$'; then
  cd "$ROOT"
  exec php "$@"
fi

PORT=$(printf '%s' "${XDEBUG_CONFIG:-}" | sed -n 's/.*client_port=\([0-9][0-9]*\).*/\1/p')
exec docker run --rm -i \
  -v "$ROOT:/app" -w /app \
  --add-host=host.docker.internal:host-gateway \
  -e XDEBUG_MODE=debug \
  -e XDEBUG_TRIGGER=1 \
  -e XDEBUG_CONFIG="client_host=host.docker.internal client_port=${PORT:-9003}" \
  --entrypoint php \
  "${E2E_PHP_IMAGE:-ddev/ddev-webserver:v1.25.4}" \
  -dzend_extension=xdebug.so -dopcache.jit=disable "$@"
