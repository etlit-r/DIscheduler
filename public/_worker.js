// Cloudflare Pages の入口（advanced mode）。本体のコード（src/index.ts）をそのまま使う。
// Pages はデプロイ時にこのファイルを束ねて（bundle して）動かす。静的ファイルとしては配信されない。
// どのパスでこの処理を動かすかは _routes.json で決める（それ以外は静的ファイルとして配信し、_headers を付ける）。
export { default } from "../src/index";
