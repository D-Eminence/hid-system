#!/usr/bin/env bash
set -euo pipefail

acceptance_repository="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
acceptance_pg_bindir="$(pg_config --bindir)"
acceptance_root="$(mktemp -d /tmp/hid-container-db.XXXXXX)"
acceptance_data="$acceptance_root/data"
acceptance_port="${HID_ACCEPTANCE_DATABASE_PORT:-55439}"
acceptance_admin="$(id -un)"
acceptance_started=false
acceptance_children=()

case "$acceptance_root" in
  /tmp/hid-container-db.*) ;;
  *) echo "Unsafe temporary acceptance path" >&2; exit 1 ;;
esac
if ! [[ "$acceptance_port" =~ ^[0-9]+$ ]] || (( acceptance_port < 1024 || acceptance_port > 65535 )); then
  echo "HID_ACCEPTANCE_DATABASE_PORT must be an unprivileged TCP port" >&2
  exit 1
fi
if ! [[ "$acceptance_admin" =~ ^[A-Za-z_][A-Za-z0-9_-]*$ ]]; then
  echo "The local PostgreSQL administrator name is not safe for this disposable test" >&2
  exit 1
fi

cleanup_acceptance() {
  for acceptance_pid in "${acceptance_children[@]:-}"; do
    if kill -0 "$acceptance_pid" 2>/dev/null; then kill -TERM "$acceptance_pid" 2>/dev/null || true; fi
  done
  if [[ "$acceptance_started" == true ]]; then
    "$acceptance_pg_bindir/pg_ctl" -D "$acceptance_data" -m fast stop >/dev/null 2>&1 || true
  fi
  rm -rf -- "$acceptance_root"
}
trap cleanup_acceptance EXIT INT TERM

"$acceptance_pg_bindir/initdb" -D "$acceptance_data" --auth-local=trust --auth-host=trust --no-locale --encoding=UTF8 >/dev/null
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj '/CN=localhost' \
  -addext 'subjectAltName=DNS:localhost,IP:127.0.0.1' \
  -keyout "$acceptance_root/server.key" -out "$acceptance_root/server.crt" >/dev/null 2>&1
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj '/CN=untrusted.invalid' \
  -keyout "$acceptance_root/untrusted.key" -out "$acceptance_root/untrusted.crt" >/dev/null 2>&1
chmod 600 "$acceptance_root/server.key"

start_database() {
  if ! "$acceptance_pg_bindir/pg_ctl" -D "$acceptance_data" -l "$acceptance_root/postgresql.log" \
    -o "-h 127.0.0.1 -k $acceptance_root -p $acceptance_port -c ssl=on -c ssl_cert_file=$acceptance_root/server.crt -c ssl_key_file=$acceptance_root/server.key" \
    -w start >/dev/null; then
    tail -30 "$acceptance_root/postgresql.log" >&2
    exit 1
  fi
  acceptance_started=true
}

start_database
"$acceptance_pg_bindir/createdb" -h 127.0.0.1 -p "$acceptance_port" -U "$acceptance_admin" hid
acceptance_ca_base64="$(base64 -w0 "$acceptance_root/server.crt")"
acceptance_admin_url="postgresql://$acceptance_admin@localhost:$acceptance_port/hid"

env NODE_ENV=test DATABASE_URL="$acceptance_admin_url" DATABASE_SSL=true \
  DATABASE_SSL_ROOT_CERT_BASE64="$acceptance_ca_base64" \
  npm --prefix "$acceptance_repository/services/ehr-api" run db:dry-run
env NODE_ENV=test DATABASE_URL="$acceptance_admin_url" DATABASE_SSL=true \
  DATABASE_SSL_ROOT_CERT_BASE64="$acceptance_ca_base64" \
  npm --prefix "$acceptance_repository/services/ehr-api" run db:migrate
env NODE_ENV=test DATABASE_ADMIN_URL="$acceptance_admin_url" DATABASE_SSL=true \
  DATABASE_SSL_ROOT_CERT_BASE64="$acceptance_ca_base64" \
  npm --prefix "$acceptance_repository/services/ehr-api" run db:bootstrap
env NODE_ENV=test DATABASE_ADMIN_URL="$acceptance_admin_url" DATABASE_SSL=true \
  DATABASE_SSL_ROOT_CERT_BASE64="$acceptance_ca_base64" \
  npm --prefix "$acceptance_repository/services/ehr-api" run db:verify-roles
PGSSLMODE=verify-full PGSSLROOTCERT="$acceptance_root/server.crt" \
  "$acceptance_pg_bindir/psql" -h localhost -p "$acceptance_port" -U "$acceptance_admin" -d hid \
  -v ON_ERROR_STOP=1 -f "$acceptance_repository/services/ehr-api/database/tests/schema.integration.sql" >/dev/null
env NODE_ENV=test DATABASE_URL="$acceptance_admin_url" DATABASE_SSL=true \
  DATABASE_SSL_ROOT_CERT_BASE64="$acceptance_ca_base64" \
  npm --prefix "$acceptance_repository/services/ehr-api" run db:plan
echo 'acceptance stage: migrations/schema passed'

PGSSLMODE=verify-full PGSSLROOTCERT="$acceptance_root/server.crt" \
  "$acceptance_pg_bindir/psql" -h localhost -p "$acceptance_port" -U "$acceptance_admin" -d hid \
  -v ON_ERROR_STOP=1 -c "
    create role hid_accept_identity login inherit;
    create role hid_accept_ehr login inherit;
    create role hid_accept_lab login inherit;
    create role hid_accept_pharmacy login inherit;
    create role hid_accept_ocr_api login inherit;
    create role hid_accept_ocr_worker login inherit;
    create role hid_accept_outreach login inherit;
    create role hid_accept_dispatcher login inherit;
    grant hid_identity_api_runtime to hid_accept_identity;
    grant hid_ehr_api_runtime to hid_accept_ehr;
    grant hid_lab_api_runtime to hid_accept_lab;
    grant hid_pharmacy_api_runtime to hid_accept_pharmacy;
    grant hid_ocr_api_runtime to hid_accept_ocr_api;
    grant hid_ocr_worker to hid_accept_ocr_worker;
    grant hid_outreach_api_runtime to hid_accept_outreach;
    grant hid_event_dispatcher to hid_accept_dispatcher;
  " >/dev/null

acceptance_roles=(hid_accept_identity hid_accept_ehr hid_accept_lab hid_accept_pharmacy \
  hid_accept_ocr_api hid_accept_ocr_worker hid_accept_outreach hid_accept_dispatcher)
for acceptance_role in "${acceptance_roles[@]}"; do
  acceptance_seen="$(PGSSLMODE=verify-full PGSSLROOTCERT="$acceptance_root/server.crt" \
    "$acceptance_pg_bindir/psql" -h localhost -p "$acceptance_port" -U "$acceptance_role" -d hid \
    -Atqc 'select current_user')"
  if [[ "$acceptance_seen" != "$acceptance_role" ]]; then
    echo "Representative login did not authenticate as $acceptance_role" >&2
    exit 1
  fi
done

deny_mutation() {
  local acceptance_role="$1"
  local acceptance_sql="$2"
  local acceptance_denial
  if acceptance_denial="$(PGSSLMODE=verify-full PGSSLROOTCERT="$acceptance_root/server.crt" \
      "$acceptance_pg_bindir/psql" -h localhost -p "$acceptance_port" -U "$acceptance_role" -d hid \
      -v ON_ERROR_STOP=1 -v VERBOSITY=verbose -c "$acceptance_sql" 2>&1)"; then
    echo "Unexpected cross-domain mutation privilege for $acceptance_role" >&2
    exit 1
  fi
  if [[ "$acceptance_denial" != *42501* ]]; then
    echo "Cross-domain denial for $acceptance_role did not return SQLSTATE 42501" >&2
    exit 1
  fi
}

deny_mutation hid_accept_identity 'delete from ehr.encounters where false'
deny_mutation hid_accept_ehr 'delete from identity.patients where false'
deny_mutation hid_accept_lab 'delete from identity.patients where false'
deny_mutation hid_accept_pharmacy 'delete from lab.work_items where false'
deny_mutation hid_accept_ocr_api 'delete from ehr.encounters where false'
deny_mutation hid_accept_ocr_worker 'delete from ehr.encounters where false'
deny_mutation hid_accept_outreach 'delete from identity.patients where false'
deny_mutation hid_accept_dispatcher 'delete from identity.patients where false'
echo 'acceptance stage: representative logins/denials passed'

acceptance_safe_logins="$(PGSSLMODE=verify-full PGSSLROOTCERT="$acceptance_root/server.crt" \
  "$acceptance_pg_bindir/psql" -h localhost -p "$acceptance_port" -U "$acceptance_admin" -d hid -Atqc \
  "select count(*) from pg_roles where rolname = any(array['hid_accept_identity','hid_accept_ehr','hid_accept_lab','hid_accept_pharmacy','hid_accept_ocr_api','hid_accept_ocr_worker','hid_accept_outreach','hid_accept_dispatcher']) and rolcanlogin and not (rolsuper or rolcreaterole or rolcreatedb or rolreplication or rolbypassrls)")"
if [[ "$acceptance_safe_logins" != 8 ]]; then
  echo "Representative login attribute check failed" >&2
  exit 1
fi

acceptance_tls="$(PGSSLMODE=verify-full PGSSLROOTCERT="$acceptance_root/server.crt" \
  "$acceptance_pg_bindir/psql" -h localhost -p "$acceptance_port" -U hid_accept_identity -d hid \
  -Atqc 'select ssl from pg_stat_ssl where pid = pg_backend_pid()')"
if [[ "$acceptance_tls" != t ]]; then
  echo "Representative connection did not negotiate PostgreSQL TLS" >&2
  exit 1
fi
if PGSSLMODE=verify-full PGSSLROOTCERT="$acceptance_root/untrusted.crt" \
  "$acceptance_pg_bindir/psql" -h localhost -p "$acceptance_port" -U hid_accept_identity -d hid \
  -Atqc 'select 1' >/dev/null 2>&1; then
  echo "PostgreSQL unexpectedly trusted the wrong acceptance CA" >&2
  exit 1
fi
echo 'acceptance stage: PostgreSQL TLS passed'

acceptance_secret='abcdefghijklmnopqrstuvwxyz123456'
acceptance_common=(NODE_ENV=development DATABASE_SSL=true DATABASE_SSL_ROOT_CERT_BASE64="$acceptance_ca_base64"
  DATABASE_POOL_MAX=2 CORS_ORIGINS=http://localhost:3000 TRUST_PROXY_CIDRS=127.0.0.1/32
  AUTH_MODE=local AUTH_SIGNING_SECRET="$acceptance_secret" AUTH_LOGIN_PEPPER="$acceptance_secret"
  AUTH_COOKIE_SECURE=false STORAGE_MODE=disabled
  IDENTITY_API_URL=http://127.0.0.1:3001 LAB_API_URL=http://127.0.0.1:3003
  PHARMACY_API_URL=http://127.0.0.1:3004 EHR_API_URL=http://127.0.0.1:3002
  IDENTITY_SERVICE_IDENTITY_MODE=local-secret EHR_SERVICE_IDENTITY_MODE=local-secret
  LAB_SERVICE_IDENTITY_MODE=local-secret PHARMACY_SERVICE_IDENTITY_MODE=local-secret
  OUTREACH_IDENTITY_SERVICE_IDENTITY_MODE=local-secret EHR_INTERNAL_SERVICE_TOKEN="$acceptance_secret"
  LAB_INTERNAL_SERVICE_TOKEN="$acceptance_secret" PHARMACY_INTERNAL_SERVICE_TOKEN="$acceptance_secret"
  IDENTITY_EHR_INTERNAL_SERVICE_TOKEN="$acceptance_secret" IDENTITY_LAB_INTERNAL_SERVICE_TOKEN="$acceptance_secret"
  IDENTITY_PHARMACY_INTERNAL_SERVICE_TOKEN="$acceptance_secret" IDENTITY_OCR_INTERNAL_SERVICE_TOKEN="$acceptance_secret"
  OUTREACH_IDENTITY_INTERNAL_SERVICE_TOKEN="$acceptance_secret"
  NOTIFICATION_IDENTITY_INTERNAL_SERVICE_TOKEN="$acceptance_secret")

start_api() {
  local acceptance_service="$1"
  local acceptance_port_number="$2"
  local acceptance_role="$3"
  env "${acceptance_common[@]}" PORT="$acceptance_port_number" \
    DATABASE_URL="postgresql://$acceptance_role@localhost:$acceptance_port/hid" \
    node "$acceptance_repository/services/$acceptance_service/dist/main.js" \
    >"$acceptance_root/$acceptance_service.log" 2>&1 &
  acceptance_children+=("$!")
}

start_api identity-api 3001 hid_accept_identity
start_api ehr-api 3002 hid_accept_ehr
start_api lab-api 3003 hid_accept_lab
start_api pharmacy-api 3004 hid_accept_pharmacy
start_api ocr-api 3005 hid_accept_ocr_api
start_api outreach-api 3006 hid_accept_outreach

for acceptance_api_port in 3001 3002 3003 3004 3005 3006; do
  acceptance_api_ready=false
  for _ in {1..80}; do
    if [[ "$(curl -s --max-time 2 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$acceptance_api_port/api/v1/health/ready" || true)" == 200 ]]; then acceptance_api_ready=true; break; fi
    sleep 0.25
  done
  if [[ "$acceptance_api_ready" != true ]]; then
    echo "API on port $acceptance_api_port did not become ready" >&2
    for acceptance_api_log in "$acceptance_root"/*-api.log; do tail -20 "$acceptance_api_log" >&2; done
    exit 1
  fi
  if [[ "$(curl -sS --max-time 2 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$acceptance_api_port/api/v1/health/live")" != 200 ]] \
      || [[ "$(curl -sS --max-time 2 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$acceptance_api_port/api/v1/health/ready")" != 200 ]]; then
    echo "API health changed during acceptance on port $acceptance_api_port" >&2
    exit 1
  fi
done
echo 'acceptance stage: six API health endpoints passed'

for acceptance_worker_index in 1 2; do
  env NODE_ENV=test OCR_PROVIDER=test \
    OCR_WORKER_DATABASE_URL="postgresql://hid_accept_ocr_worker@localhost:$acceptance_port/hid" \
    OCR_WORKER_SUBJECT="acceptance:ocr-worker:$acceptance_worker_index" OCR_WORKER_DATABASE_SSL=true \
    OCR_WORKER_DATABASE_SSL_ROOT_CERT_BASE64="$acceptance_ca_base64" OCR_WORKER_POLL_MS=100 \
    node "$acceptance_repository/services/ocr-worker/dist/main.js" \
    >"$acceptance_root/ocr-worker-$acceptance_worker_index.log" 2>&1 &
  acceptance_children+=("$!")
done
for acceptance_dispatcher_index in 1 2; do
  acceptance_status_port=$((3009 + acceptance_dispatcher_index))
  env NODE_ENV=test EVENT_DISPATCHER_ENABLED=true EVENT_DISPATCHER_TRANSPORT=deterministic \
    EVENT_DISPATCHER_DATABASE_URL="postgresql://hid_accept_dispatcher@localhost:$acceptance_port/hid" \
    EVENT_DISPATCHER_DATABASE_SSL=true EVENT_DISPATCHER_DATABASE_SSL_ROOT_CERT_BASE64="$acceptance_ca_base64" \
    EVENT_DISPATCHER_ID="acceptance-dispatcher-$acceptance_dispatcher_index" EVENT_DISPATCHER_POLL_MS=100 \
    EVENT_DISPATCHER_STATUS_HOST=127.0.0.1 EVENT_DISPATCHER_STATUS_PORT="$acceptance_status_port" \
    node "$acceptance_repository/services/event-dispatcher/dist/main.js" \
    >"$acceptance_root/event-dispatcher-$acceptance_dispatcher_index.log" 2>&1 &
  acceptance_children+=("$!")
done

for _ in {1..80}; do
  if grep -q 'ocr.worker.ready' "$acceptance_root/ocr-worker-1.log" \
      && grep -q 'ocr.worker.ready' "$acceptance_root/ocr-worker-2.log" \
      && [[ "$(curl -sS --max-time 2 -o /dev/null -w '%{http_code}' http://127.0.0.1:3010/api/v1/health/ready || true)" == 200 ]] \
      && [[ "$(curl -sS --max-time 2 -o /dev/null -w '%{http_code}' http://127.0.0.1:3011/api/v1/health/ready || true)" == 200 ]]; then break; fi
  sleep 0.25
done
grep -q 'ocr.worker.ready' "$acceptance_root/ocr-worker-1.log"
grep -q 'ocr.worker.ready' "$acceptance_root/ocr-worker-2.log"
[[ "$(curl -sS --max-time 2 -o /dev/null -w '%{http_code}' http://127.0.0.1:3010/api/v1/health/ready)" == 200 ]]
[[ "$(curl -sS --max-time 2 -o /dev/null -w '%{http_code}' http://127.0.0.1:3011/api/v1/health/ready)" == 200 ]]

for acceptance_index in 6 7 8 9; do kill -TERM "${acceptance_children[$acceptance_index]}"; done
for acceptance_index in 6 7 8 9; do wait "${acceptance_children[$acceptance_index]}"; done
grep -q 'ocr.worker.stopped' "$acceptance_root/ocr-worker-1.log"
grep -q 'ocr.worker.stopped' "$acceptance_root/ocr-worker-2.log"
grep -q 'event_dispatcher.stopped' "$acceptance_root/event-dispatcher-1.log"
grep -q 'event_dispatcher.stopped' "$acceptance_root/event-dispatcher-2.log"
echo 'acceptance stage: two workers/two dispatchers/SIGTERM passed'

"$acceptance_pg_bindir/pg_ctl" -D "$acceptance_data" -m fast -w stop >/dev/null
acceptance_started=false
for acceptance_api_port in 3001 3002 3003 3004 3005 3006; do
  acceptance_live_code="$(curl -s --max-time 2 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$acceptance_api_port/api/v1/health/live" || true)"
  acceptance_ready_code="$(curl -sS --max-time 8 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$acceptance_api_port/api/v1/health/ready" || true)"
  if [[ "$acceptance_live_code" != 200 || "$acceptance_ready_code" == 200 || "$acceptance_ready_code" == 000 ]]; then
    echo "Database failure health mismatch on port $acceptance_api_port: live=$acceptance_live_code ready=$acceptance_ready_code" >&2
    for acceptance_api_log in "$acceptance_root"/*-api.log; do tail -20 "$acceptance_api_log" >&2; done
    exit 1
  fi
done
echo 'acceptance stage: database failure readiness passed'
start_database
for acceptance_api_port in 3001 3002 3003 3004 3005 3006; do
  acceptance_api_ready=false
  for _ in {1..80}; do
    if [[ "$(curl -s --max-time 2 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$acceptance_api_port/api/v1/health/ready" || true)" == 200 ]]; then acceptance_api_ready=true; break; fi
    sleep 0.25
  done
  if [[ "$acceptance_api_ready" != true ]]; then
    echo "API did not recover readiness on port $acceptance_api_port" >&2
    exit 1
  fi
done
echo 'acceptance stage: database restart readiness passed'

for acceptance_index in 0 1 2 3 4 5; do kill -TERM "${acceptance_children[$acceptance_index]}"; done
for acceptance_index in 0 1 2 3 4 5; do
  set +e
  wait "${acceptance_children[$acceptance_index]}"
  acceptance_exit_status=$?
  set -e
  # Node reports 143 when Nest's shutdown hook closes the server and the
  # original SIGTERM remains the process exit cause. Both 0 and 143 are
  # normal, bounded shutdown outcomes; any other status is a failure.
  if [[ "$acceptance_exit_status" != 0 && "$acceptance_exit_status" != 143 ]]; then
    echo "API process index $acceptance_index exited with unexpected status $acceptance_exit_status after SIGTERM" >&2
    exit 1
  fi
done
echo 'acceptance stage: six API SIGTERM exits passed'

for acceptance_role in "${acceptance_roles[@]}"; do
  PGSSLMODE=verify-full PGSSLROOTCERT="$acceptance_root/server.crt" \
    "$acceptance_pg_bindir/psql" -h localhost -p "$acceptance_port" -U "$acceptance_admin" -d hid \
    -v ON_ERROR_STOP=1 -c "drop role $acceptance_role" >/dev/null
done
acceptance_remaining="$(PGSSLMODE=verify-full PGSSLROOTCERT="$acceptance_root/server.crt" \
  "$acceptance_pg_bindir/psql" -h localhost -p "$acceptance_port" -U "$acceptance_admin" -d hid -Atqc \
  "select count(*) from pg_roles where rolname like 'hid_accept_%'")"
[[ "$acceptance_remaining" == 0 ]]

"$acceptance_pg_bindir/pg_ctl" -D "$acceptance_data" -m fast -w stop >/dev/null
acceptance_started=false
rm -rf -- "$acceptance_root"
trap - EXIT INT TERM
echo '{"status":"passed","postgresql":"16.14","migrations":"0001-0028","pending":0,"tls":"verify-full","nonOwnerLogins":8,"crossDomainDenials":8,"apiHealth":6,"apiSigterm":6,"ocrWorkers":2,"dispatchers":2,"databaseFailureReadiness":"failed-closed","temporaryClusterRemoved":true}'
