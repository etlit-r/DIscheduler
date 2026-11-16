#!/usr/bin/env bash
# デプロイ用に、静的ページへ設定値を埋め込む（docs/design.md §6.10, §14）
#
# 使い方: scripts/prepare-public.sh [元のディレクトリ（既定: public）] [出力先（既定: dist）]
#   元のディレクトリはそのまま残し、出力先にコピーしてから書き換える（手元で試しても、リポジトリのファイルは変わらない）。
#   出力先は毎回作り直す。Cloudflare Pages には出力先を配信する（pages/wrangler.jsonc の pages_build_output_dir）。
#
#   --config を付けると、Pages と Worker の設定ファイル（pages/wrangler.jsonc・wrangler.jsonc）にも値を埋め込む。
#   こちらはその場で書き換えるので、デプロイ（GitHub Actions の使い捨ての作業場所）でだけ使う。
#
# 環境変数:
#   DISCORD_APPLICATION_ID  必須。招待リンクの client_id（数字 17〜20 桁）
#   DONATION_URL            任意。寄付リンクの URL（https://...）。Ko-fi のときは、リンクの近くに説明を入れる
#                           （日本語のページは __DONATION_NOTE__、英語版のページ（en/）は __DONATION_NOTE_EN__）
#   PUBLIC_ORIGIN           任意（--config のときは必須）。正式な公開アドレス（https://...。末尾の / なし）。LP の正規 URL（canonical）など
#   --config のときだけ:  D1_DATABASE_ID・DISCORD_PUBLIC_KEY・PAGES_PROJECT（いずれも必須）
#
# 正式な公開アドレスの表示切り替え:
#   <!-- origin:start --> ... <!-- origin:end -->  PUBLIC_ORIGIN があるときだけ残し、__PUBLIC_ORIGIN__ を置き換える
#
# 寄付リンクの表示切り替え:
#   <!-- donation:start --> ... <!-- donation:end -->        寄付リンクがあるときだけ残す
#   <!-- no-donation:start --> ... <!-- no-donation:end -->  寄付リンクがないときだけ残す
# どちらの場合も、目印のコメント自体は取り除く。
#
# 最後に、出力先と設定ファイルに __大文字__ の形の置き場所や目印が残っていないかを確かめ、残っていたら止める。
set -euo pipefail

config=0
args=()
for a in "$@"; do
  if [[ "$a" == "--config" ]]; then config=1; else args+=("$a"); fi
done
src="${args[0]:-public}"
out="${args[1]:-dist}"
root="$(cd "$(dirname "$0")/.." && pwd)"

fail() { echo "::error::$1" >&2; exit 1; }

[[ -d "$src" ]] || fail "$src がありません"
# 出力先は毎回消して作り直すので、元のディレクトリやリポジトリを含む場所を指していたら止める（"." や ".." の打ち間違いで消さないように）
src_abs="$(cd "$src" && pwd)"
out_abs="$(realpath -m "$out")"
[[ "$out_abs" != "/" ]] || fail "出力先（$out）が正しくありません"
case "$out_abs/" in
  "$root/" | "$src_abs/" | "$src_abs"/*) fail "出力先（$out）が正しくありません" ;;
esac
case "$src_abs/" in "$out_abs"/*) fail "出力先（$out）が元のディレクトリを含んでいます" ;; esac
case "$root/" in "$out_abs"/*) fail "出力先（$out）がリポジトリを含んでいます" ;; esac

# --- 値の確認 ---
app_id="${DISCORD_APPLICATION_ID:-}"
[[ "$app_id" =~ ^[0-9]{17,20}$ ]] || fail "DISCORD_APPLICATION_ID が未設定か、形式が正しくありません"

# 寄付リンクの決まりと Ko-fi の説明文は、アプリと同じファイル（src/shared/donation.json）から読む
donation_json="$root/src/shared/donation.json"
json() { node -e 'const d=require(process.argv[1]); const v=process.argv[2].split(".").reduce((o,k)=>o[k],d); process.stdout.write(String(v));' "$donation_json" "$1"; }
donation_url="${DONATION_URL:-}"
donation_note=""
donation_note_en=""
if [[ -n "$donation_url" ]]; then
  # https の URL で、決まった文字だけでできているかを確かめる（HTML や置換の書き換えを防ぐ）
  [[ "$donation_url" =~ $(json urlPattern) ]] || fail "DONATION_URL の形式が正しくありません（https:// で始まる URL を指定してください）"
  if [[ "$donation_url" =~ $(json kofiPattern) ]]; then
    donation_note="$(json kofiNote.ja)"
    donation_note_en="$(json kofiNote.en)"
  fi
fi

public_origin="${PUBLIC_ORIGIN:-}"
if [[ -n "$public_origin" ]]; then
  [[ "$public_origin" =~ ^https://[a-z0-9]([a-z0-9.-]*[a-z0-9])?$ ]] || fail "PUBLIC_ORIGIN の形式が正しくありません（例: https://discheduler.etlits.dev。末尾の / なし）"
fi

# --- 出力先を作り直す ---
rm -rf "$out"
cp -R "$src" "$out"

# 出力先の HTML をすべて書き換える（フォルダを足しても漏れないよう、深さによらず探す）
mapfile -t files < <(find "$out" -name '*.html' -type f | sort)
(( ${#files[@]} > 0 )) || fail "$src に HTML がありません"

for f in "${files[@]}"; do
  sed -i "s/__DISCORD_APPLICATION_ID__/${app_id}/g" "$f"

  if [[ -n "$donation_url" ]]; then
    perl -0pi -e 's/<!-- no-donation:start -->.*?<!-- no-donation:end -->//gs; s/<!-- donation:(start|end) -->//g' "$f"
    sed -i "s#__DONATION_URL__#${donation_url}#g" "$f"
    # 支援サービスの説明。説明がなければ、その段落ごと消す
    if [[ -n "$donation_note" ]]; then
      sed -i -e "s#__DONATION_NOTE__#${donation_note}#g" -e "s#__DONATION_NOTE_EN__#${donation_note_en}#g" "$f"
    else
      perl -0pi -e 's#<p class="[^"]*">__DONATION_NOTE(_EN)?__</p>\s*##g' "$f"
    fi
  else
    perl -0pi -e 's/<!-- donation:start -->.*?<!-- donation:end -->//gs; s/<!-- no-donation:(start|end) -->//g' "$f"
  fi

  if [[ -n "$public_origin" ]]; then
    perl -0pi -e 's/<!-- origin:(start|end) -->//g' "$f"
    sed -i "s#__PUBLIC_ORIGIN__#${public_origin}#g" "$f"
  else
    perl -0pi -e 's/<!-- origin:start -->.*?<!-- origin:end -->//gs' "$f"
  fi
done

# --- 設定ファイル（--config のとき。デプロイでだけ使う） ---
config_files=()
if (( config )); then
  d1="${D1_DATABASE_ID:-}"
  pubkey="${DISCORD_PUBLIC_KEY:-}"
  project="${PAGES_PROJECT:-}"
  [[ "$d1" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] || fail "D1_DATABASE_ID が未設定か、形式が正しくありません"
  [[ "$pubkey" =~ ^[0-9a-f]{64}$ ]] || fail "DISCORD_PUBLIC_KEY が未設定か、形式が正しくありません"
  [[ "$project" =~ ^[a-z0-9][a-z0-9-]{0,57}$ ]] || fail "PAGES_PROJECT（Cloudflare Pages のプロジェクト名）が未設定か、形式が正しくありません"
  [[ -n "$public_origin" ]] || fail "PUBLIC_ORIGIN（例: https://discheduler.etlits.dev）が未設定です"
  config_files=("$root/wrangler.jsonc" "$root/pages/wrangler.jsonc")
  sed -i "s/__D1_DATABASE_ID__/${d1}/" "$root/wrangler.jsonc"
  sed -i \
    -e "s|__PAGES_PROJECT__|${project}|" \
    -e "s|__D1_DATABASE_ID__|${d1}|" \
    -e "s|__DISCORD_APPLICATION_ID__|${app_id}|" \
    -e "s|__DISCORD_PUBLIC_KEY__|${pubkey}|" \
    -e "s|__PUBLIC_ORIGIN__|${public_origin}|" \
    -e "s|__DONATION_URL__|${donation_url}|" \
    "$root/pages/wrangler.jsonc"
fi

# --- 置き換え漏れ・目印の残りがあれば止める ---
# 画面のビルド結果（app/）はライブラリの文字列を含むので除く
leftover="$(grep -rlE '__[A-Z][A-Z0-9_]*__|<!-- (no-)?(donation|origin):' "$out" --exclude-dir=app "${config_files[@]}" || true)"
[[ -z "$leftover" ]] || fail "置き換えに失敗しました: $(echo "$leftover" | tr '\n' ' ')"

echo "出力先: $out（HTML ${#files[@]} 件）"
if [[ -n "$donation_url" ]]; then echo "寄付リンク: あり"; else echo "寄付リンク: なし（寄付の欄を表示しません）"; fi
if (( config )); then echo "設定ファイル: 埋め込み済み"; fi
