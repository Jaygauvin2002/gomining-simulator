#!/usr/bin/env bash
# Produit extension.zip pour le Chrome Web Store.
#
# Le manifest du dépôt porte volontairement le suffixe « (DEV) » : c'est la
# copie qu'on charge non empaquetée, et le suffixe la distingue de la version
# du store dans chrome://extensions et dans le panneau injecté.
#
# Ce script retire ce suffixe pour le paquet publié, puis REFUSE d'écrire le
# zip si « DEV » y subsiste. Aucun renommage manuel à retenir, donc aucune
# chance de publier une extension appelée « DEV ».
set -euo pipefail

cd "$(dirname "$0")/.."
SRC=extension
OUT=extension.zip
FILES=(extractor.js icon-16.png icon-48.png icon-128.png
        inject-early.js interceptor.js manifest.json panel.css sync-bridge.js)

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

for f in "${FILES[@]}"; do
  [ -f "$SRC/$f" ] || { echo "manquant : $SRC/$f" >&2; exit 1; }
  cp "$SRC/$f" "$TMP/$f"
done

python3 - "$TMP/manifest.json" <<'PY'
import json, sys
p = sys.argv[1]
m = json.load(open(p, encoding='utf-8'))
m['name'] = m['name'].replace(' (DEV)', '').strip()
json.dump(m, open(p, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
print(f"  nom publié : {m['name']}  v{m['version']}")
PY

if grep -qi 'DEV' "$TMP/manifest.json"; then
  echo "REFUS : « DEV » subsiste dans le manifest destiné au store." >&2
  exit 1
fi

rm -f "$OUT"
( cd "$TMP" && zip -X -q "$OLDPWD/$OUT" "${FILES[@]}" )

if unzip -p "$OUT" manifest.json | grep -qi 'DEV'; then
  echo "REFUS : « DEV » présent dans le zip. Zip supprimé." >&2
  rm -f "$OUT"
  exit 1
fi

echo "  $OUT — $(du -h "$OUT" | cut -f1), $(unzip -l "$OUT" | tail -1 | awk '{print $2}') fichiers"
echo "  contrôle : aucun « DEV » dans le paquet."
