# オンラインDB連携メモ

この構成では、管理者はローカルPCで作業し、ユーザーに公開する情報だけをSupabaseへ同期します。

## 役割

- ローカルアプリ: 管理者用。名簿管理、公開設定、シフト作成を行う。
- Supabase: オンラインDB。ユーザー回答と公開シフト表を保存する。
- 公開ユーザーページ: Supabaseから希望調査・シフト表を読み込み、回答をSupabaseへ保存する。

## 追加したファイル

- `supabase_schema.sql`
  - Supabaseに作成するテーブル定義。
- `static/online-config.js`
  - 公開ユーザーページがSupabaseへ接続するための設定。
- `sync_supabase.py`
  - ローカルSQLiteとSupabaseを同期するスクリプト。
- `supabase.local.example.json`
  - 管理者PCだけで使うSupabase接続設定のサンプル。
- `build_public.py`
  - 公開ユーザー画面用のファイル一式を `public` フォルダへ作成するスクリプト。

## Supabase側の準備

1. Supabaseでプロジェクトを作成する。
2. SQL Editorで `supabase_schema.sql` の内容を実行する。
3. Project Settings > API から以下を確認する。
   - Project URL
   - anon public key
   - service_role key

## 公開ユーザーページの設定

管理者ページの `オンライン同期` から以下を入力して保存できます。

- Project URL
- anon public key
- service_role key

保存すると、管理者PC用の `supabase.local.json` と、公開ユーザー画面用の `static/online-config.js` が更新されます。
保存後は `接続テスト` を押して、Supabaseへ接続できるか確認します。

手動で設定する場合は、`static/online-config.js` を以下のように変更します。

```js
window.HIRUGAKU_ONLINE = {
  enabled: true,
  supabaseUrl: "https://xxxx.supabase.co",
  supabaseAnonKey: "anon public key",
};
```

`anon public key` はユーザー画面に入れてよい公開用キーです。
`service_role key` は絶対に公開ページへ入れないでください。

## ローカルからSupabaseへ同期

管理者ページの `オンライン同期` で接続設定を保存した場合、この作業は不要です。

手動で設定する場合は、管理者PCに `supabase.local.json` を作成します。
`supabase.local.example.json` を参考に、以下のように設定します。

```json
{
  "url": "https://xxxx.supabase.co",
  "service_key": "service_role key"
}
```

`service_role key` は管理者PCだけで使います。
公開ユーザーページには入れないでください。

PowerShellで環境変数を指定する場合は、以下の方法でも実行できます。

```powershell
$env:SUPABASE_URL="https://xxxx.supabase.co"
$env:SUPABASE_SERVICE_KEY="service_role key"
python sync_supabase.py sync
```

コマンドの意味:

- `python sync_supabase.py push`
  - ローカルの名簿、会場、公開設定、シフト日時、シフト表をSupabaseへ送る。
- `python sync_supabase.py pull`
  - Supabase上のユーザー回答をローカルへ取り込む。
- `python sync_supabase.py sync`
  - `push` と `pull` の両方を実行する。

管理者画面の `オンライン同期` ページからも同じ操作ができます。

## 公開ユーザー画面の作成

公開前に `static/online-config.js` を設定し、以下を実行します。

```powershell
python build_public.py
```

作成された `public` フォルダを Netlify、Cloudflare Pages、GitHub Pages などへ配置します。
管理者画面の `オンライン同期` にある `公開用ファイルを作成` ボタンからも同じ操作ができます。

## 現時点の注意

この実装はオンライン連携の土台です。
公開ユーザーページを24時間使えるようにするには、`static` フォルダ相当をNetlify、GitHub Pages、Cloudflare Pagesなどへ置く必要があります。
