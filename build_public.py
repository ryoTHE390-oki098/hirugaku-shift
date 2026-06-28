from pathlib import Path
import shutil


ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "static"
PUBLIC = ROOT / "public"


def copy_public_files():
    (PUBLIC / "static").mkdir(parents=True, exist_ok=True)

    shutil.copy2(STATIC / "styles.css", PUBLIC / "static" / "styles.css")
    shutil.copy2(STATIC / "app.js", PUBLIC / "static" / "app.js")
    shutil.copy2(STATIC / "online-config.js", PUBLIC / "static" / "online-config.js")
    shutil.copy2(STATIC / "index.html", PUBLIC / "index.html")
    print(f"公開用ファイルを作成しました: {PUBLIC}")


if __name__ == "__main__":
    copy_public_files()
