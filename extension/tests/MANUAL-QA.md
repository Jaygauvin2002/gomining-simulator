# Recette avant de téléverser une mise à jour au Chrome Web Store

La version publiée reste en ligne pendant que tu testes. On ne téléverse
qu'une fois cette liste terminée — pas de patch du patch en production.

## 0. Automatique d'abord

```
node extension/tests/routing.test.mjs
node extension/tests/merge.test.mjs
node extension/tests/bonus-miner.test.mjs
node extension/tests/capital.test.mjs [chemin-vers-un-export.json]
node extension/tests/reward-day.test.mjs [chemin-vers-un-export.json]
node extension/tests/reward-formula.test.mjs
node extension/tests/reinvest-th.test.mjs
node extension/tests/capital-persist.test.mjs
node extension/tests/migration.test.mjs
node extension/tests/daily-avg.test.mjs
node extension/tests/portfolio-refresh.test.mjs
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
- [ ] `client/find-one` présent — c'est le **Bonus miner**, rangé sous ce nom
      parce que la clé ne garde que les deux derniers segments d'URL
- [ ] la puissance affichée dans GMSim égale celle du widget « Mining farm »
      de GoMining, bonus inclus
- [ ] **ferme l'onglet, rouvre gmsim.ca sans repasser sur GoMining** : le capital
      et le coût par TH doivent toujours être là. Le relevé brut est purgé au bout
      de 24 h par l'extension, c'est le résultat du calcul qui est conservé.
- [ ] le Portfolio indique « Depuis tes dépôts GoMining » sous le capital, et
      non le message de repli — sinon le relevé n'a pas été capté assez loin
      (il faut aussi les `asset-conversion`, pas seulement les dépôts, pour
      que les taux soient mesurables)
- [ ] `wallet/transaction-history` présent, et ses lignes réduites à 8 champs
      (`id`, `createdAt`, `type`, `fromType`, `valueNumeric`, `walletType`,
      `hasDepositTx`, `hasWithdrawOrder`) — aucun `travelRule*`, aucun `metadata`
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
- [ ] le dernier jour du calendrier est **hier**, pas aujourd'hui — GoMining
      écrit l'enregistrement le lendemain du jour miné, et c'est `calculatedAt`
      qui donne le vrai jour
- [ ] le PR affiché correspond au poolReward réel du dernier jour complet, pas
      à la valeur par défaut de 47 sat/TH
- [ ] le gain net quotidien correspond au `gmtIncomeBasedOnBtcIncome` du dernier
      jour dans GoMining — désormais à moins de 0,5 %, pas « à quelques pourcents »
- [ ] le sat/TH net égale celui de l'écran « Reward » de GoMining
      (`PR + GBP − C1 − C2`)
- [ ] Pool Reward / sat-per-TH cohérents
- [ ] pas d'erreur dans la console

## 4bis. Règle sur les données stockées

**Migrer, jamais jeter.** Un changement de format qui invalide un stockage doit
s'accompagner d'une fonction de conversion, pas d'un `removeItem`. Le 2026-08-26
la correction de datation a d'abord été livrée avec une suppression : le décalage
était pourtant d'exactement un jour, donc réparable sans perte, et tout ce qu'un
utilisateur avait accumulé au-delà de ce que l'extension retient encore a été
détruit pour rien.

Si une migration est réellement impossible, le dire dans le message de commit et
expliquer pourquoi. `migration.test.mjs` échoue si `loadRewardHistory` recommence
à supprimer.

## 5. Seulement maintenant

Bumper la version dans `manifest.json`, puis :

```
./extension/build-zip.sh
node extension/tests/routing.test.mjs
node extension/tests/merge.test.mjs
node extension/tests/bonus-miner.test.mjs
node extension/tests/capital.test.mjs [chemin-vers-un-export.json]
node extension/tests/reward-day.test.mjs [chemin-vers-un-export.json]
node extension/tests/reward-formula.test.mjs
node extension/tests/reinvest-th.test.mjs
node extension/tests/capital-persist.test.mjs
node extension/tests/migration.test.mjs
node extension/tests/daily-avg.test.mjs
node extension/tests/portfolio-refresh.test.mjs
```

Le script retire le suffixe `(DEV)` du paquet publié et refuse d'écrire le
zip s'il en reste la moindre trace. Téléverser ensuite dans la console
développeur. **Une seule fois.**
