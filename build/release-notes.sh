#!/bin/bash
#
# Release notes for end users.
#
#   release-notes.sh range              Print the commit range since the last
#                                       release on this branch.
#   release-notes.sh generate <range>   Print the notes as JSON.
#   release-notes.sh render <format> <json-file>
#                                       Print the notes as Markdown. Formats:
#                                       changelog, plg, github, tag.
#
# `generate` asks Claude to sort the commits by what a plugin user notices.
# New features, visible changes and user-reported bug fixes are listed one by
# one. Work a user never sees (tests, CI, refactors, internal fixes and
# performance work) becomes one "Internal fixes and performance improvements"
# line. Without ANTHROPIC_API_KEY, or when the call fails, it sorts by the
# conventional commit prefix instead, so a release never fails on the notes.
#
# Each item carries the pull request and issue numbers its commits name, and
# the notes print them after the item: "... (#18)". Only numbers that appear
# in the commit messages are kept, so the model cannot add one.
#
# JSON shape: {"new": [Item], "improved": [Item], "fixed": [Item], "internal": N}
#   Item: {"text": "One sentence.", "refs": [18, 7]}

set -euo pipefail

MODEL="${RELEASE_NOTES_MODEL:-claude-opus-5-5}"
SKIP_SUBJECT='^Update PLG .*for release'

# Dev releases compare against the last dev tag, stable releases against the
# last stable tag. Without a tag, the last 20 commits.
cmd_range() {
  local branch last
  branch=$(git branch --show-current 2>/dev/null || echo main)
  if [ "$branch" = "dev" ]; then
    last=$(git describe --tags --abbrev=0 --match 'v*-dev*' HEAD 2>/dev/null || true)
  else
    last=$(git describe --tags --abbrev=0 --exclude 'v*-dev*' HEAD 2>/dev/null || true)
  fi
  if [ -n "$last" ]; then
    echo "${last}..HEAD"
  else
    echo "HEAD~20..HEAD"
  fi
}

# One block per commit: hash, subject, body and changed paths. The paths let
# the model tell a test-only or CI-only commit from one that changes the UI.
commit_log() {
  local range="$1" hash subject
  git log "$range" --no-merges --format='%H' | while read -r hash; do
    subject=$(git log -1 --format='%s' "$hash")
    if [[ "$subject" =~ $SKIP_SUBJECT ]]; then continue; fi
    printf '=== commit %s\n' "${hash:0:8}"
    git log -1 --format='%B' "$hash"
    printf 'Files:\n'
    git show --name-only --format='' "$hash" | sed 's/^/  /'
    printf '\n'
  done
}

# Every "#123" in the commit messages, as a JSON array of numbers. A ref the
# model returns that is not in this list is dropped.
known_refs() {
  { grep -oE '#[0-9]+' <<<"$1" || true; } | tr -d '#' | sort -un | jq -s -c '.'
}

# Sort by the conventional commit prefix. Used when Claude is not available.
# A "(#18)" in a subject becomes the item's ref.
fallback_notes() {
  local range="$1"
  git log "$range" --no-merges --format='%s' \
    | { grep -Ev "$SKIP_SUBJECT" || true; } \
    | jq -R -s '
        split("\n") | map(select(length > 0)) as $subjects
        | def strip: sub("^[a-z]+(\\([^)]*\\))?!?: *"; "")
                     | (.[0:1] | ascii_upcase) + .[1:];
          def item: {
            text: (strip | gsub(" *\\(#[0-9]+\\)"; "")),
            refs: ([scan("#([0-9]+)")[0] | tonumber] | unique)
          };
        {
          new:      [$subjects[] | select(test("^feat(\\(|!|:)")) | item],
          improved: [],
          fixed:    [$subjects[] | select(test("^fix(\\(|!|:)")) | item],
          internal: ([$subjects[] | select(test("^(feat|fix)(\\(|!|:)") | not)] | length)
        }'
}

read -r -d '' SYSTEM_PROMPT <<'EOF' || true
You write release notes for Docker Folders, an Unraid plugin. Its users are
Unraid server owners. They organize Docker containers into folders, watch
container stats, read logs, update images, edit Docker Compose stacks, run
schedules and backups, and change plugin settings. They do not read the code.

You get the git commits of one release. Sort what changed by what a user
notices:

- new: a feature the user can now use. For example a new button, setting,
  page, schedule action or procedure.
- improved: a visible change to something that already existed. For example
  a layout change, a clearer message or a faster screen the user can feel.
- fixed: a bug fix a user could see. Always list a fix for a reported bug,
  which is a commit that names a GitHub issue (#123) or says a user reported
  it.
- internal: the number of commits a user never sees. Tests, CI, build and
  release tooling, refactors, documentation, code review fixes, internal
  fixes and performance work behind the scenes all count here. When a commit
  touches only tests, CI, docs or build files, it is internal.

Rules:
- Merge commits that make one change into one item. A fix for a bug that
  another commit in this same list added is internal, because no user saw it.
- Write each item as one short sentence in plain English, in the present
  tense, from the user's side: "Backup schedules can dump each Postgres
  database to its own archive." Name the screen or setting where it helps.
- Say only what the commits say. Do not invent details or numbers.
- refs: the pull request and issue numbers that the commits behind an item
  name, such as "(#18)" in a squash merge subject, "Merge pull request #5",
  "Fixes #12" or "from #18". Give the number only. Use an empty list when the
  commits name none. Never put a number in text, only in refs.
- No code identifiers, file paths, commit prefixes or hashes, unless the user
  types or sees that text (a setting name, a command).
- An empty list is fine. Do not move an internal change into a list to fill it.
EOF

cmd_generate() {
  local range="$1" log request response notes
  log=$(commit_log "$range")
  if [ -z "$log" ]; then
    echo '{"new":[],"improved":[],"fixed":[],"internal":0}'
    return
  fi

  if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
    echo "release-notes: ANTHROPIC_API_KEY is not set, sorting by commit prefix" >&2
    fallback_notes "$range"
    return
  fi

  request=$(jq -n --arg model "$MODEL" --arg system "$SYSTEM_PROMPT" --arg log "$log" '
  {
    type: "object",
    properties: {
      text: {type: "string"},
      refs: {type: "array", items: {type: "integer"}}
    },
    required: ["text", "refs"],
    additionalProperties: false
  } as $item | {
    model: $model,
    max_tokens: 16000,
    fallbacks: "default",
    output_config: {
      effort: "low",
      format: {
        type: "json_schema",
        schema: {
          type: "object",
          properties: {
            new:      {type: "array", items: $item},
            improved: {type: "array", items: $item},
            fixed:    {type: "array", items: $item},
            internal: {type: "integer"}
          },
          required: ["new", "improved", "fixed", "internal"],
          additionalProperties: false
        }
      }
    },
    system: $system,
    messages: [{role: "user", content: ("Commits in this release:\n\n" + $log)}]
  }')

  # A failed call, a refusal or JSON that does not match falls back. The
  # release must not stop because of its notes.
  #
  # The key goes to curl as a header file, so it is never in curl's argv,
  # where `ps` and /proc/<pid>/cmdline show it. printf is a builtin, so it
  # does not start a process either.
  if response=$(curl -sS --fail-with-body --max-time 300 https://api.anthropic.com/v1/messages \
        -H "Content-Type: application/json" \
        -H @<(printf 'x-api-key: %s\n' "$ANTHROPIC_API_KEY") \
        -H "anthropic-version: 2023-06-01" \
        -H "anthropic-beta: server-side-fallback-2026-07-01" \
        -d "$request") \
     && [ "$(jq -r '.stop_reason' <<<"$response")" = "end_turn" ] \
     && notes=$(jq -r '[.content[] | select(.type == "text") | .text] | join("")' <<<"$response" \
                | jq -c --argjson known "$(known_refs "$log")" '
                    select((.new|type) == "array" and (.improved|type) == "array"
                           and (.fixed|type) == "array" and (.internal|type) == "number")
                    | (.new, .improved, .fixed) |= map(.refs |= (map(select(IN($known[]))) | unique))') \
     && [ -n "$notes" ]; then
    echo "$notes"
  else
    echo "release-notes: Claude call failed, sorting by commit prefix" >&2
    printf '%s\n' "${response:-}" | head -c 2000 >&2 || true
    fallback_notes "$range"
  fi
}

cmd_render() {
  local format="$1" file="$2"
  jq -r --arg format "$format" '
    # A ref the text already names ("from #18") is not repeated.
    def with_refs: .text as $t
      | [.refs[] | "#" + tostring | . as $ref | select(($t | test($ref + "(?![0-9])")) | not)] as $r
      | $t + (if ($r | length) > 0 then " (" + ($r | join(", ")) + ")" else "" end);
    def items($prefix): .[] | "- " + $prefix + with_refs;
    def internal_line: if .internal > 0 then "- Internal fixes and performance improvements." else empty end;
    def section($title; $list): if ($list | length) > 0 then "### " + $title, ($list | items("")), "" else empty end;
    if $format == "changelog" or $format == "github" then
      section("New"; .new),
      section("Improved"; .improved),
      section("Fixed"; .fixed),
      (if .internal > 0 then "### Internal", internal_line, "" else empty end)
    elif $format == "plg" then
      # <CHANGES> in the .plg is plain XML, not CDATA.
      [(.new | items("New: ")),
       (.improved | items("Improved: ")),
       (.fixed | items("Fixed: ")),
       internal_line] | .[] | gsub("&"; "&amp;") | gsub("<"; "&lt;") | gsub(">"; "&gt;")
    else
      (.new | items("New: ")),
      (.improved | items("Improved: ")),
      (.fixed | items("Fixed: ")),
      internal_line
    end
  ' "$file"
}

case "${1:-}" in
  range) cmd_range ;;
  generate) cmd_generate "${2:?range required}" ;;
  render) cmd_render "${2:?format required}" "${3:?json file required}" ;;
  *) echo "usage: $0 range | generate <range> | render <changelog|plg|github|tag> <json-file>" >&2; exit 2 ;;
esac
