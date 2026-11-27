# Chrysalide pour Linux

Application Tauri 2 hors ligne avec un moteur de morphing en Rust et un détecteur MediaPipe embarqué.

## Télécharger et installer

Ouvre la page de la [dernière version](https://github.com/tecochard/chrysalide/releases/latest). En bas, dans **Assets**, télécharge le fichier qui correspond à ton système :

| Système (x86-64) | Fichier à télécharger | Commande d’installation |
| --- | --- | --- |
| Debian / Ubuntu | `Chrysalide_…_amd64.deb` | `sudo apt install ./Chrysalide_0.1.0_amd64.deb` |
| Arch Linux | `chrysalide-…-x86_64.pkg.tar.zst` | `sudo pacman -U ./chrysalide-0.1.0-1-x86_64.pkg.tar.zst` |

Ouvre un terminal dans le dossier de téléchargement et lance la commande en utilisant le nom exact du fichier téléchargé. Ensuite, lance **Chrysalide** depuis le menu des applications.

Pas besoin de télécharger les archives **Source code**. Aucun installateur Windows ou macOS n’est disponible pour le moment.

## Bibliothèque

Un seul fichier par compte Linux : `${XDG_DATA_HOME:-$HOME/.local/share}/fr.chrysalide.app/atelier.sqlite3`. Il contient les originaux, repères, PNG et recettes. Ce fichier n’est pas chiffré par l’application.

- **Importer une bibliothèque** dans **Chenilles** : choisir une sauvegarde SQLite Chrysalide. L’appli copie les entrées sans recalculer les repères et sans modifier le fichier source. L’import est réservé à une bibliothèque vide pour éviter tout écrasement.
- **Exporter la bibliothèque** : créer une copie SQLite autonome. Pour transférer sur un autre appareil, importer cette copie sur une installation vide.

## Compiler

Préparer Rust stable, Node.js (22 ou plus récent), npm, `pkg-config`, `libwebkit2gtk-4.1-dev`, `libayatana-appindicator3-dev`, `librsvg2-dev` et les outils de compilation Linux. Depuis la racine du dépôt :

```sh
npm ci
npm run assets
npm run tauri -- build --bundles deb
```

Le paquet Debian/Ubuntu est dans `target/release/bundle/deb/`. Les tests du moteur et des transferts SQLite ne nécessitent pas WebKit : `cargo test --release --no-default-features --locked`.

## MediaPipe

`npm run assets` télécharge le modèle officiel Face Landmarker `float16/1`, vérifie son empreinte SHA-256 et le garde en cache hors Git. Le modèle est ensuite embarqué pour une utilisation hors ligne. Le dépôt ne contient ni le modèle binaire ni les installateurs.

Voir [les mentions tierces](licenses/THIRD-PARTY.md) et [la licence Apache 2.0](licenses/Apache-2.0.txt). Les builds Linux livrent ces fichiers dans `/usr/share/doc/chrysalide/`.
