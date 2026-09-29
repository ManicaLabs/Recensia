# Bibliothèques vendorisées (versions figées)

Aucune dépendance n'est chargée depuis un CDN à l'exécution. Mise à jour : remplacer le fichier,
mettre à jour ce tableau (version, empreinte SHA-256), relancer `node tools/check.mjs && node --test`.

| Fichier | Bibliothèque | Version | Licence | Source | SHA-256 |
|---|---|---|---|---|---|
| `fflate.mjs` | fflate (build ESM navigateur `esm/browser.js`) | 0.8.2 | MIT (`fflate.LICENSE`) | npm `fflate@0.8.2` (intégrité npm vérifiée) | `8cc1f687e0159e977addb6b85e274dbd11e622cf151f4fcb7b85d49622ea43e7` |
| `xlsx.mjs` | SheetJS Community Edition (build ESM) | 0.20.3 | Apache-2.0 (`xlsx.LICENSE`) | `https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs` | `1a0fb062ee9781b13f6687371b202aaefc53b6ce55b530c027e01f9c087b77db` |
| `qrcode.mjs` | qrcode-generator (Kazuhiko Arase, `dist/qrcode.mjs`) | 2.0.4 | MIT (en-tête du fichier) | npm `qrcode-generator@2.0.4` (intégrité npm vérifiée) | `ea91d7118a5395289170da848b7c6758b996163bfbccf312591ab65a4911b7c0` |

Contraintes vérifiées : aucun `eval` / `new Function` (compatibles avec la CSP `script-src 'self'`),
utilisables sous Node ≥ 20 (tests) et dans le navigateur sans build.
