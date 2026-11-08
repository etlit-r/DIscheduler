#!/usr/bin/env bash
# デプロイ前に public/ の静的ページへ設定値を埋め込む（docs/design.md §6.10, §14）
#
#   DISCORD_APPLICATION_ID  必須。招待リンクの client_id（数字 17〜20 桁）
#   DONATION_URL            任意。寄付リンクの URL（https://...）
#
# 寄付リンクの表示切り替え:
#   <!-- donation:start --> ... <!-- donation:end -->        寄付リンクがあるときだけ残す
#   <!-- no-donation:start --> ... <!-- no-donation:end -->  寄付リンクがないときだけ残す
# どちらの場合も、目印のコメント自体は取り除く。
#
# 使い方: scripts/prepare-public.sh [対象ディレクトリ（既定: public）]
set -euo pipefail

dir="${1:-public}"
shopt -s nullglob
files=("$dir"/*.html)
if (( ${#files[@]} == 0 )); then
  echo "::error::$dir に HTML がありません" >&2
  exit 1
fi

fail() { echo "::error::$1" >&2; exit 1; }

# --- 招待リンク ---
app_id="${DISCORD_APPLICATION_ID:-}"
[[ "$app_id" =~ ^[0-9]{17,20}$ ]] || fail "DISCORD_APPLICATION_ID が未設定か、形式が正しくありません"

# --- 寄付リンク ---
donation_url="${DONATION_URL:-}"
if [[ -n "$donation_url" ]]; then
  # https の URL で、決まった文字だけでできているかを確かめる（HTML や置換の書き換えを防ぐ）
  # src/shared/text.ts の DONATION_URL_PATTERN と同じ規則（変えるときは両方そろえる）
  [[ "$donation_url" =~ ^https://[A-Za-z0-9.-]+(/[A-Za-z0-9._~/-]*)?$ ]] \
    || fail "DONATION_URL の形式が正しくありません（https:// で始まる URL を指定してください）"
fi

for f in "${files[@]}"; do
  sed -i "s/__DISCORD_APPLICATION_ID__/${app_id}/g" "$f"

  if [[ -n "$donation_url" ]]; then
    perl -0pi -e 's/<!-- no-donation:start -->.*?<!-- no-donation:end -->//gs; s/<!-- donation:(start|end) -->//g' "$f"
    sed -i "s#__DONATION_URL__#${donation_url}#g" "$f"
  else
    perl -0pi -e 's/<!-- donation:start -->.*?<!-- donation:end -->//gs; s/<!-- no-donation:(start|end) -->//g' "$f"
  fi

  # 置き換え漏れ・目印の残りがあれば止める
  if grep -qE "__DISCORD_APPLICATION_ID__|__DONATION_URL__|<!-- (no-)?donation:" "$f"; then
    fail "$f の置き換えに失敗しました"
  fi
done

if [[ -n "$donation_url" ]]; then
  echo "寄付リンク: あり"
else
  echo "寄付リンク: なし（寄付の欄を表示しません）"
fi
