
#!/usr/bin/env bash

set -Eeuo pipefail

# --- Configuration ---

PROJECT_DIR="/home/razvanut-admin/git_repos/GameAIWordGame"
NAS_MOUNT="/mnt/nas"
BACKUP_DIR="$NAS_MOUNT/gameaiwordgame/mongodb-backups"

TIMESTAMP=$(date +%Y-%m-%d_%H-%M-%S)
FINAL_FILE="$BACKUP_DIR/mongodb-$TIMESTAMP.archive.gz"
TEMP_FILE="$BACKUP_DIR/.mongodb-$TIMESTAMP.tmp"

# Load environment variables
set -a
source "$PROJECT_DIR/.env"
set +a

# --- On/off switch ---

if [ "${MONGO_BACKUP_ENABLED:-false}" != "true" ]; then
    echo "$(date): MongoDB backup disabled."
    exit 0
fi

# --- Email notifications ---

send_alert() {
    local subject="$1"
    local message="$2"

    printf 'To: %s\nSubject: %s\n\n%s\n' \
        "$BACKUP_ALERT_EMAIL" "$subject" "$message" \
        | msmtp "$BACKUP_ALERT_EMAIL"
}

backup_failed() {
    local exit_code=$?

    trap - ERR

    # Remove any incomplete backup
    rm -f "$TEMP_FILE" || true

    echo "$(date): ERROR - MongoDB backup failed (code $exit_code)." >&2

    send_alert \
        "MongoDB backup FAILED - $(hostname)" \
        "MongoDB backup failed on $(hostname).

Time: $(date)
Exit code: $exit_code

Check the MongoDB container, NAS mount, and backup log." \
        || echo "WARNING: Failed to send email alert." >&2

    exit "$exit_code"
}

trap backup_failed ERR

# --- Check NAS availability ---

if ! mountpoint -q "$NAS_MOUNT"; then
    echo "ERROR: NAS is not mounted at $NAS_MOUNT" >&2
    false
fi

# Verify the NAS is writable
mkdir -p "$BACKUP_DIR"

if ! touch "$BACKUP_DIR/.write-test"; then
    echo "ERROR: NAS backup directory is not writable." >&2
    false
fi

rm -f "$BACKUP_DIR/.write-test"

# --- Create MongoDB backup ---

echo "$(date): Starting MongoDB backup..."

docker compose \
    -f "$PROJECT_DIR/compose.yaml" \
    exec -T mongo \
    mongodump \
    --username "$MONGO_BACKUP_USERNAME" \
    --password "$MONGO_BACKUP_PASSWORD" \
    --authenticationDatabase admin \
    --archive \
    --gzip \
    > "$TEMP_FILE"

# Reject empty archives
if [ ! -s "$TEMP_FILE" ]; then
    echo "ERROR: Backup archive is empty." >&2
    false
fi

# Publish backup only after successful completion
mv "$TEMP_FILE" "$FINAL_FILE"

echo "$(date): Backup successful: $FINAL_FILE"

# --- Retention: keep 30 days ---

find "$BACKUP_DIR" \
    -maxdepth 1 \
    -type f \
    -name "mongodb-*.archive.gz" \
    -mtime +30 \
    -delete

echo "$(date): Backup and cleanup completed."

