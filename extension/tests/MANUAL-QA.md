# Recette avant de téléverser une mise à jour au Chrome Web Store

La version publiée reste en ligne pendant que tu testes. On ne téléverse
qu'une fois cette liste terminée — pas de patch du patch en production.

## 0. Automatique d'abord

```
node extension/tests/routing.test.mjs
node extension/tests/merge.test.mjs
```

Doit afficher `OK`. Ce test relit les regex **dans** `extractor.js` et rejoue
le routage contre des URLs relevées dans de vrais exports. Il couvre :
ce qui doit être stocké, ce qui ne doit jamais l'être (`auth/isAuth-v2`, le
bundle i18n, `nft-collection/index`, les prêts, TON…), la non-duplication de
l'historique, la coupe à 30 jours, et la restriction de `prices.raw`.

Il ne remplace pas les étapes ci-dessous : il ne sait rien de ce qui se passe
dans un vrai navigateur.

## 1. Installer la version candidate

1. `chrome://extensions/` → **désactive** la version venant du store.
   Sans ça, deux extensions s'injectent sur `app.gomining.com` : deux
   panneaux, et les deux écrivent dans le `localStorage` de gmsim.ca — le
   dernier gagne et tu ne sais plus laquelle tu observes.
2. Mode développeur → **Charger l'extension non empaquetée** →
   `/Users/mac/Documents/GOMINING/extension`
3. La tuile chargée s'appelle **« GMSim — Miner Sync (DEV) »** — celle du
   store n'a pas ce suffixe. Le panneau injecté sur GoMining affiche aussi
   « GMSim Sync (DEV) », donc tu sais laquelle tourne sur la page sans avoir
   à comparer des numéros de version.
4. Vérifie quand même le numéro de version sur la tuile.

## 2. Capture

Recharge l'onglet `app.gomining.com` (**F5 obligatoire** — les scripts de
contenu ne se remplacent pas à chaud dans une page déjà ouverte), puis passe
sur **chaque** page : My miners, Rewards, Marketplace, veGMT lock, Miner Wars.

Le panneau doit indiquer « Sync auto actif · N requêtes ».

## 3. Export et contrôle

Clique **Exporter JSON** dans le panneau, puis vérifie :

- [ ] `nft/get-my` présent (mineurs, puissance)
- [ ] `nft-income/find-aggregated-by-date` présent **dans `rewards` seulement**,
      jamais dans `miners`
- [ ] au plus 30 jours dans `rewards[...].data.data.array`
- [ ] `wallet/find-by-user` présent (soldes)
- [ ] `home-page/get-info-v2` présent (prix)
- [ ] **aucune** entrée `auth/`, `i18n`, `banner-configuration`,
      `academy`, `nft-collection/index`, `loan-api`
- [ ] recherche de `intercomJwt`, `kyc`, `userAgent` dans le fichier :
      zéro résultat
- [ ] poids total sous ~1,5 Mo

Puis **supprime l'export** : même propre, il contient tes soldes et tes
adresses de portefeuille.

## 4. Côté simulateur

Sur `gmsim.ca` (ou en local) :

- [ ] la puissance de ferme correspond à ce que GoMining affiche
- [ ] le calendrier des récompenses est rempli et à jour
- [ ] la pastille de fraîcheur est verte, pas ambre
- [ ] Pool Reward / sat-per-TH cohérents
- [ ] pas d'erreur dans la console

## 5. Seulement maintenant

Bumper la version dans `manifest.json`, puis :

```
./extension/build-zip.sh
node extension/tests/routing.test.mjs
node extension/tests/merge.test.mjs
```

Le script retire le suffixe `(DEV)` du paquet publié et refuse d'écrire le
zip s'il en reste la moindre trace. Téléverser ensuite dans la console
développeur. **Une seule fois.**
