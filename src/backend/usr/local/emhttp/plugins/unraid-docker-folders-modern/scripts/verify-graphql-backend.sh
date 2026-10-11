#!/bin/bash
#
# Checks the GraphQL backend against the Unraid API it runs in. Run it as root
# on the Unraid server, with the backend installed, after every Unraid or
# Unraid Connect update, and before widening include/api-compat.json.
#
#   verify-graphql-backend.sh [--api-key <key>] [--restart-check]
#
#   --api-key <key>   also query and subscribe with an API key. Create one with
#                     `unraid-api apikey --create --name "dfm verify"
#                     --roles ADMIN`. This is the check for unraid/api issue
#                     #2092, where 7.4.0-beta.3 refused API-key requests with
#                     "Invalid CSRF token".
#   --restart-check   stop and start the Unraid API, and check that the
#                     backend loads again. The API is offline for about
#                     15 seconds.
#
# Everything else is read only. Each check prints PASS, FAIL or SKIP, and the
# script exits 1 when any check fails.
#
# The rules it covers come from testing, not from upstream documentation:
# the backend's fields stay guarded, an API key still works, the
# dockerFoldersEvents subscription still answers, and `unraid-api stop`
# followed by `start` still loads the plugin.

export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:${PATH}"

PLUGIN_DIR="/usr/local/emhttp/plugins/unraid-docker-folders-modern"
API_DIR="/usr/local/unraid-api"
API_SOCKET="/var/run/unraid-api.sock"
API_LOG="/var/log/graphql-api.log"

API_KEY=""
RESTART_CHECK=0
while [ $# -gt 0 ]; do
  case "$1" in
    --api-key) API_KEY="$2"; shift 2 ;;
    --restart-check) RESTART_CHECK=1; shift ;;
    *) echo "usage: $0 [--api-key <key>] [--restart-check]" >&2; exit 2 ;;
  esac
done

FAILED=0
pass() { echo "PASS  $*"; }
fail() { echo "FAIL  $*"; FAILED=1; }
skip() { echo "SKIP  $*"; }

# POST a GraphQL query over the API socket. Extra curl arguments follow it.
gql() {
  local query="$1"; shift
  curl -s --max-time 10 --unix-socket "${API_SOCKET}" -H "Content-Type: application/json" "$@" \
    -d "{\"query\":\"${query}\"}" http://localhost/graphql
}

# 1. The API version is in the tested range.
if out=$(php "${PLUGIN_DIR}/scripts/api-version.php" --json </dev/null); then
  pass "API version is in the tested range: ${out}"
else
  fail "API version: ${out}"
fi

# 2. The API runs.
if timeout 15 unraid-api status 2>/dev/null | grep -q online; then
  pass "unraid-api status reports online"
else
  fail "unraid-api status does not report online. The checks below will fail too."
fi

# 3. The backend's field is in the schema, and an anonymous request is
# refused. GRAPHQL_VALIDATION_FAILED means the plugin did not load; data
# means @UsePermissions no longer guards the field.
body=$(gql 'query { dockerFoldersInfo { version } }')
if echo "${body}" | grep -q 'UNAUTHENTICATED' && echo "${body}" | grep -q '"dockerFoldersInfo"'; then
  pass "dockerFoldersInfo is in the schema and refuses an anonymous request"
elif echo "${body}" | grep -q 'GRAPHQL_VALIDATION_FAILED'; then
  fail "dockerFoldersInfo is not in the schema. The API did not load the backend. ${body}"
elif echo "${body}" | grep -q '"data":{"dockerFoldersInfo":{'; then
  fail "dockerFoldersInfo answered an anonymous request. @UsePermissions no longer guards it. ${body}"
else
  fail "Unexpected answer to the anonymous probe: ${body}"
fi

# 4. An API key reaches a guarded field.
if [ -n "${API_KEY}" ]; then
  body=$(gql 'query { dockerFoldersInfo { version databaseReadable } }' -H "x-api-key: ${API_KEY}")
  if echo "${body}" | grep -q '"databaseReadable":true'; then
    pass "An API key reads dockerFoldersInfo, and the plugin reads its database"
  elif echo "${body}" | grep -q 'Invalid CSRF token'; then
    fail "An API key is refused with \"Invalid CSRF token\". This is unraid/api issue #2092. ${body}"
  else
    fail "An API key does not read dockerFoldersInfo: ${body}"
  fi
else
  skip "API-key query. Pass --api-key to run it."
fi

# 5. The dockerFoldersEvents subscription. The guard runs per operation, so
# connection_ack proves nothing: the check waits for the subscribe's answer.
# Anonymous, it must be refused with an auth error, which also proves that
# the field exists. With a key, it must stay open without an error.
WS_MODULE="${API_DIR}/node_modules/ws"
if [ ! -d "${WS_MODULE}" ]; then
  skip "subscription. The API has no ws module at ${WS_MODULE}."
else
  result=$(timeout 20 node - "${WS_MODULE}" "${API_SOCKET}" "${API_KEY}" <<'NODE' 2>&1
const [wsModule, socket, apiKey] = process.argv.slice(2);
const WebSocket = require(wsModule);
const ws = new WebSocket(`ws+unix://${socket}:/graphql`, 'graphql-transport-ws');
const params = apiKey ? { 'x-api-key': apiKey } : {};
const done = (line) => { console.log(line); ws.terminate(); process.exit(0); };
ws.on('open', () => ws.send(JSON.stringify({ type: 'connection_init', payload: params })));
ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.type === 'connection_ack') {
    ws.send(JSON.stringify({
      id: '1',
      type: 'subscribe',
      payload: { query: 'subscription { dockerFoldersEvents { entity action timestamp } }' },
    }));
    // No error in this time means the subscription is open and waits for an event.
    setTimeout(() => done('OPEN'), 3000);
  } else if (msg.type === 'error' || msg.type === 'complete') {
    done('ERROR ' + JSON.stringify(msg.payload ?? msg));
  } else if (msg.type === 'next') {
    done(msg.payload?.errors ? 'ERROR ' + JSON.stringify(msg.payload.errors) : 'OPEN');
  }
});
ws.on('close', (code, reason) => done(`CLOSED ${code} ${reason}`));
ws.on('error', (e) => done('SOCKET ' + e.message));
NODE
)
  if [ -n "${API_KEY}" ]; then
    case "${result}" in
      OPEN) pass "dockerFoldersEvents accepts a subscription with an API key" ;;
      *) fail "dockerFoldersEvents with an API key: ${result}" ;;
    esac
  else
    case "${result}" in
      ERROR*) if echo "${result}" | grep -qi 'Cannot query field'; then
                fail "dockerFoldersEvents is not in the schema: ${result}"
              else
                pass "dockerFoldersEvents refuses an anonymous subscription: ${result}"
              fi ;;
      OPEN) fail "dockerFoldersEvents opened for an anonymous subscription. @UsePermissions no longer guards it." ;;
      *) fail "dockerFoldersEvents: ${result}" ;;
    esac
  fi
fi

# 6. stop, then start, loads the plugin. api-plugin.sh depends on this,
# because `unraid-api restart` did not reload plugins on API 4.35.1.
if [ "${RESTART_CHECK}" = "1" ]; then
  timeout 60 unraid-api stop >/dev/null 2>&1
  timeout 60 unraid-api start >/dev/null 2>&1
  loaded=0
  for _ in $(seq 1 20); do
    sleep 3
    if gql 'query { dockerFoldersInfo { version } }' | grep -q '"dockerFoldersInfo"'; then
      loaded=1
      break
    fi
  done
  if [ "${loaded}" = "1" ]; then
    pass "unraid-api stop, then start, loads the backend again"
  else
    fail "The backend did not answer within 60 seconds of unraid-api stop and start"
  fi
else
  skip "stop and start. Pass --restart-check to run it."
fi

# 7. No plugin or schema error in the API log since its last start.
if [ -r "${API_LOG}" ]; then
  errors=$(tail -n 500 "${API_LOG}" | grep -iE 'is invalid|Schema must|GraphQLError|docker-folders.*(error|failed)' | tail -5)
  if [ -z "${errors}" ]; then
    pass "No plugin or schema error in the last 500 lines of ${API_LOG}"
  else
    fail "Errors in ${API_LOG}:"
    echo "${errors}" | sed 's/^/      /'
  fi
else
  skip "API log. ${API_LOG} is not readable."
fi

exit "${FAILED}"
