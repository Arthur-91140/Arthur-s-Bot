# Arthur's Bot

Bots Minecraft (Java Edition) pour **tester vos serveurs et vos plugins** : des bots qui se connectent, se déplacent, combattent, construisent, cassent, discutent, cliquent dans les menus… pilotés depuis une interface web, une console, ou de façon totalement automatisée en CI.

- **Toutes les versions Java de 1.8.8 à 26.1** (auto-détection par ping ou version forcée) — testé en réel sur des serveurs vanilla 1.8.8, 1.12.2, 1.16.5, 1.20.4 et 1.21.11.
- **16 modes prédéfinis** : inactif, anti-AFK, promeneur, suiveur, explorateur, connexion/déconnexion en boucle, garde, combattant, mineur, fermier, bâtisseur, casseur, bavard, testeur de commandes, testeur de menus (GUI), observateur.
- **Programmation visuelle de comportements** (« wireframe ») : éditeur de graphes à nœuds dans le navigateur, **80 nœuds** (évènements, logique, variables, déplacement, actions, inventaire/GUI, monde, tests), exécution visible en direct sur le graphe.
- **Essaims** : des dizaines de bots avec un motif de nom (`Bot_{i}`), délai anti-flood entre connexions, actions groupées, signaux de synchronisation.
- **Rapports de test** (assertions, mesures, latences, TPS) consultables dans l'interface, exportables en JSON et **JUnit** pour la CI.
- Auth **hors ligne** (serveurs en `online-mode=false`) ou **Microsoft**, réponse automatique **AuthMe** (`/register`, `/login`), reconnexion automatique, réapparition, nourriture, armure, acceptation des packs de ressources.

---

## Sommaire

1. [Installation](#installation)
2. [Démarrage rapide](#démarrage-rapide)
3. [L'interface web](#linterface-web)
4. [Modes prédéfinis](#modes-prédéfinis)
5. [Programmation visuelle](#programmation-visuelle)
6. [Expressions](#expressions)
7. [Tests automatisés et CI](#tests-automatisés-et-ci)
8. [Console interactive](#console-interactive)
9. [Configuration](#configuration)
10. [API REST](#api-rest)
11. [Compatibilité et limites](#compatibilité-et-limites)
12. [Architecture et extension](#architecture-et-extension)

---

## Installation

Prérequis : **Node.js 22 ou plus récent**.

```bash
git clone https://github.com/Arthur-91140/Arthur-s-Bot.git
cd Arthur-s-Bot
npm install
```

## Démarrage rapide

```bash
npm start                 # interface web + console interactive
npm run web               # interface web seule
```

Ouvrez **http://127.0.0.1:3000**, puis :

1. Dans **Serveur**, indiquez l'adresse et le port, cliquez sur **Ping** : la version est détectée et sa compatibilité affichée.
2. Dans **Créer des bots**, saisissez un pseudo (`Testeur`) ou un motif (`Bot_{i}`) et un nombre, puis **Créer et connecter**.
3. Cliquez sur une carte de bot pour ouvrir sa fiche : console de chat, contrôles, mode, inventaire, menus, comportements, plugins, journal.

Options utiles : `--host`, `--port` (serveur Minecraft), `--version 1.20.4`, `--web-port 8080`, `--web-host 0.0.0.0 --token monsecret`, `--no-repl`, `--no-web`.

## L'interface web

| Onglet | Contenu |
| --- | --- |
| **Tableau de bord** | Ping du serveur (version, protocole, joueurs, MOTD, latence), création de bots/essaims, cartes des bots (vie, faim, position, ping, **TPS estimé**, mode, graphes), actions groupées (connexion, déconnexion, chat, mode, graphe, signal, suppression). |
| **Fiche d'un bot** | Console de chat en direct (historique ↑), contrôles de déplacement (maintenir), « aller à », regard, attaque, utilisation d'objet ; mode + options ; inventaire cliquable ; **menu (GUI) ouvert avec clic gauche/droit/Maj sur les cases** ; graphes en cours ; plugins ; journal du bot. |
| **Éditeur de comportements** | Programmation visuelle (voir plus bas). |
| **Rapports** | Résultats des tests : statut, vérifications ✔/✘, mesures (min/moy/max + courbe), journal, erreurs ; export JSON. |
| **Journal** | Tous les logs, filtrables par bot, niveau et texte. |
| **Aide** | Rappel de la syntaxe des expressions, des fonctions et des modes. |

## Modes prédéfinis

Un mode est un comportement prêt à l'emploi, configurable par des options (fiche du bot → **Mode**, action groupée, console, nœud « Changer de mode », ou `autostart`).

| Mode | Usage typique |
| --- | --- |
| **Inactif** (`idle`) | Rester connecté : test de connexion, de charge, de kick AFK. |
| **Anti-AFK** (`antiafk`) | Petites actions aléatoires pour ne pas être détecté AFK. |
| **Promeneur** (`wander`) | Marche aléatoire autour du point d'apparition. |
| **Suiveur** (`follow`) | Suit un joueur (ou le plus proche). |
| **Explorateur** (`explorer`) | Avance loin (direction, aléatoire, spirale) : génération/chargement de chunks, performance. |
| **Connexion / déconnexion** (`joinleave`) | Cycles join/quit : évènements de connexion, fuites mémoire, anti-bot. |
| **Garde** (`guard`) | Défend sa position contre les monstres (et joueurs en option). |
| **Combattant** (`pvp`) | Attaque une cible (joueur nommé, le plus proche, monstres) : arènes, plugins PvP, anti-cheat. |
| **Mineur** (`miner`) | Récolte un type de bloc (`oak_log`, `*_ore`…). |
| **Fermier** (`farmer`) | Récolte les cultures mûres et replante. |
| **Bâtisseur** (`builder`) | Pose des blocs (au hasard, en ligne, en pilier) et compte les refus : **test de protections** (WorldGuard, claims…), résultat attendu « autorisé » ou « refusé ». |
| **Casseur** (`breaker`) | Casse des blocs et détecte ceux que le serveur restaure : anti-grief, protections. |
| **Bavard** (`chatter`) | Messages en boucle (`{i}`, `{rand}`, `{time}`, `{username}`) : filtres de chat, anti-spam. |
| **Testeur de commandes** (`commander`) | Liste de commandes, capture des réponses, latence, détection des échecs (« Unknown command », permission…) → rapport. |
| **Testeur de menus** (`gui`) | Ouvre un menu (commande ou objet), liste son contenu, clique des cases → rapport. |
| **Observateur** (`observer`) | Mesure périodique TPS / ping / joueurs / entités / chunks → rapport de monitoring. |

`node bin/arthur-bot.js modes` affiche toutes les options de chaque mode.

## Programmation visuelle

L'éditeur (onglet **Éditeur de comportements**) permet de construire un comportement en reliant des nœuds :

- Un **nœud évènement** (⚡ en rouge : « Au démarrage », « Message reçu », « Toutes les X ms », « Joueur connecté », « Menu ouvert », « Entité à proximité », « Signal reçu »…) démarre un **flux** chaque fois qu'il se déclenche.
- Le flux suit les **liens** de sortie en sortie : « Si » a deux sorties *Vrai/Faux*, « Aller à » a *Arrivé/Échec*, « Commande + réponse attendue » a *Réponse OK/Échec*…
- Une sortie reliée à plusieurs nœuds lance les branches **en parallèle** ; « Séquence » les exécute dans l'ordre.
- Les boucles sont possibles (relier un nœud en arrière, « Répéter », « Tant que », « Pour chaque joueur »). Une boucle sans attente est automatiquement interrompue avec un message clair.
- Les paramètres acceptent des **expressions** : `bot.health < 10`, `{{ event.username }}`… (voir ci-dessous).

**Utilisation de l'éditeur** : glisser un nœud depuis la palette (ou double-clic sur le fond pour l'ajout rapide), glisser une sortie vers un nœud pour relier, glisser une entrée reliée pour détacher le lien, clic droit pour le menu contextuel, molette pour zoomer, Maj+glisser pour une sélection rectangulaire. Raccourcis : Suppr, Ctrl+C/V/D, Ctrl+Z/Y, Ctrl+S, Ctrl+A, F (tout afficher).

**▶ Lancer** exécute le graphe affiché (même non enregistré) sur les bots choisis : les nœuds **clignotent quand ils s'exécutent** et passent en **rouge en cas d'erreur** (message au survol et dans l'inspecteur). Relancer un graphe sur un bot remplace l'exécution précédente.

Les graphes sont enregistrés en JSON dans `graphs/` (versionnables avec git). Exemples fournis :

| Fichier | Démontre |
| --- | --- |
| `exemple-accueil-chat` | Réponses aux messages (`!pos`, `!suis-moi`, `!stop`) et aux messages privés. |
| `exemple-test-commandes` | Scénario de test complet, compatible CI. |
| `exemple-patrouille` | Boucle sur des points de passage + défense contre les monstres. |
| `exemple-essaim-chat` | Coordination d'essaim par signal et variable partagée. |
| `exemple-test-menu` | Test d'un menu de plugin (ouverture, contenu, clic). |
| `exemple-survie` | Surveillance faim/vie/morts/téléportations (setbacks d'anti-cheat). |

`node bin/arthur-bot.js nodes` liste les 80 nœuds avec leur description.

## Expressions

Mini-langage sûr (aucun accès à JavaScript ni au système), utilisé dans les champs « expr », les champs numériques et entre `{{ }}` dans les textes.

```text
bot.health < 10 && hasItem('bread')
"Salut " + event.username
compteur % 10 == 0 ? "dizaine" : "autre"
match(event.message, "(\w+) a rejoint")[1]
distanceTo(0, 64, 0) > 20 or not playerOnline("Arthur")
```

- Opérateurs : `+ - * / %`, `== != === !== < > <= >=`, `&& || !` (ou `and or not`), `??`, `a ? b : c`, listes `[1, 2]`, accès `obj.champ`, `liste[0]`.
- `bot.*` : `username, health, food, x, y, z, blockX/Y/Z, yaw, pitch, dimension, gameMode, ping, tps, players, playerNames, heldItem, isDay, timeOfDay, windowTitle, emptySlots, moving, online`.
- `event.*` : données de l'évènement (`message`, `username`, `match`, `player`, `reason`, `count`, `title`, `entity`…).
- Variables : du graphe (propriétés du graphe ou « Définir une variable »), du flux (`index`, `found`, `entity`, `response`, `latency`, `window`…), partagées entre bots (`shared.nom`).
- Fonctions du bot : `hasItem, countItem, blockAt, blockBelow, distanceTo, nearestPlayer, nearestEntity, entityCount, playerOnline, players, playerPos, findBlock, inventoryFull, isManaged, botNames, lastMessage, online`.
- Fonctions générales : `random, randInt, pick, round, floor, ceil, abs, min, max, sqrt, pow, clamp, len, str, num, int, bool, lower, upper, trim, contains, startsWith, endsWith, matches, match, replace, split, join, keys, json, parseJson, now, time, date, typeOf, dist`.

## Tests automatisés et CI

Les nœuds de la catégorie **Tests** produisent un rapport : « Vérifier » (assertion), « Commande + réponse attendue » (envoi + regex + latence), « Attendre un message », « Attendre un évènement », « Mesurer », chronomètres, « Noter », « Fin du test ».

En CI, la commande `run` connecte les bots, exécute le graphe jusqu'au nœud « Fin du test » (ou jusqu'au délai), écrit les rapports et renvoie le code de sortie **0** (tout réussi) ou **1** :

```bash
node bin/arthur-bot.js run graphs/exemple-test-commandes.json \
  --host localhost --port 25565 --bots 3 --timeout 120 \
  --junit rapport.xml --report rapport.json
```

Un exemple de workflow GitHub Actions qui démarre un serveur Paper avec votre plugin puis lance les bots se trouve dans [`docs/exemple-ci-serveur.yml`](docs/exemple-ci-serveur.yml).

## Console interactive

Au lancement (`npm start`), une console est disponible dans le terminal (cible = nom de bot, `all`, liste `a,b` ou motif `Bot_*`) :

```text
add Testeur wander              swarm 20 Bot_{i} antiafk         say all /spawn
mode Bot_* follow {"target":"Arthur"}                            goto Testeur 100 ~ -50
run exemple-patrouille Bot_*    signal go all                    reports
focus Testeur                   ping play.monserveur.fr:25565    help
```

## Configuration

Copiez `config/config.example.json` en `config/config.json` (ignoré par git) ; seules les valeurs présentes remplacent celles de `config/default.json`.

- `server` : hôte, port, version par défaut (`auto` = détection).
- `bot` : authentification, reconnexion (délai, nombre max), plugins (réapparition, nourriture, armure, pack de ressources, AuthMe + mot de passe).
- `swarm` : motif de nom et délai entre connexions par défaut.
- `web` : adresse d'écoute, port, **jeton d'accès** (obligatoire si vous exposez l'interface sur le réseau ; à passer en `?token=` dans l'URL ou en en-tête `Authorization: Bearer`).
- `autostart` : bots/essaims créés au démarrage, avec mode et/ou graphe.

Variables d'environnement : `MC_HOST`, `MC_PORT`, `MC_VERSION`, `WEB_HOST`, `WEB_PORT`, `WEB_TOKEN`, `ARTHUR_CONFIG`.

L'authentification Microsoft affiche un code à saisir sur microsoft.com/link (dans les logs et sur la carte du bot) ; le jeton est ensuite mis en cache dans `.auth/`.

## API REST

Toutes les actions de l'interface passent par l'API (utilisable depuis vos scripts) :

| Méthode | Route | Rôle |
| --- | --- | --- |
| GET | `/api/info` | Versions, modes, nœuds, plugins. |
| GET | `/api/ping?host=&port=` | Ping d'un serveur. |
| GET/POST | `/api/bots` | Liste / création (`username` ou `namePattern` + `count`, `mode`, `graph`, `plugins`…). |
| GET/DELETE | `/api/bots/:id` | État complet / suppression. |
| POST | `/api/bots/:id/:action` | `connect, disconnect, reconnect, chat, mode, control, goto, gotoPlayer, stop, look, attack, dropAll, respawn, useItem, swing, equip, hotbar, armor, click, closeWindow, plugins, trigger`. |
| GET | `/api/bots/:id/inventory`, `/window`, `/chat` | Inventaire, menu ouvert, chat. |
| POST | `/api/bulk` | `{ targets, action, ... }` sur plusieurs bots. |
| GET/POST/PUT/DELETE | `/api/graphs[/:id]` | Graphes enregistrés. |
| POST | `/api/run` | `{ graphId | graph, targets }` lance un graphe. |
| GET/POST | `/api/runtimes`, `/api/runtimes/:id/stop`, `/api/runtimes/stop` | Exécutions en cours. |
| POST | `/api/trigger` | `{ name, data, targets }` envoie un signal. |
| GET/DELETE | `/api/reports[/:id]` | Rapports. |
| GET | `/api/logs?source=&level=&limit=` | Journal. |

Le canal temps réel (Socket.IO) diffuse : `bots`, `logs`, `chats`, `traces`, `report`, `runtime`, `graphs`.

## Compatibilité et limites

- **Java Edition 1.8.8 → 26.1** via [mineflayer](https://github.com/PrismarineJS/mineflayer). Les serveurs plus récents que la version supportée doivent utiliser ViaVersion/ViaBackwards (le bot se connecte alors avec une version supportée).
- **Bedrock** n'est pas supporté (protocole différent). Les **mods** Forge/Fabric côté client ne sont pas émulés (les serveurs « vanilla-compatibles » comme Paper, Spigot, Purpur, Folia, Velocity, BungeeCord fonctionnent).
- Le **TPS** affiché est une estimation à partir des mises à jour de temps envoyées par le serveur.
- Les déplacements utilisent un pathfinder : par défaut les bots **ne cassent ni ne posent de blocs** pour se déplacer (pour ne pas fausser vos tests), sauf option contraire.
- Serveur 1.8.x récent sous Java 17+ : ajoutez `use-native-transport=false` dans `server.properties` si les connexions sont réinitialisées.
- N'utilisez ces bots que sur **vos** serveurs ou avec l'accord de leurs administrateurs.

## Architecture et extension

```text
bin/arthur-bot.js        point d'entrée CLI (start, run, ping, versions, modes, nodes)
src/app.js               assemblage : configuration, journal, gestionnaire, web, console
src/core/                BotManager (bots, essaims, graphes, signaux), BotInstance (connexion,
                         reconnexion, état, actions), plugins utilitaires, navigation, rapports, ping
src/modes/               modes prédéfinis (basic, combat, world, testing)
src/graph/               moteur de graphes : registry, GraphRuntime, expression, nodes/*
src/web/server.js        API REST + Socket.IO + fichiers statiques
src/cli/                 console interactive et mode CI (JUnit)
public/                  interface web (sans framework ni étape de build)
graphs/                  graphes enregistrés (JSON)
test/                    tests (npm test)
```

**Ajouter un mode** : créez un objet `{ name, label, category, description, options, start(ctx), stop?(ctx) }` dans `src/modes/*.js`. Le contexte `ctx` fournit `bot`, `options`, `log`, `every()`, `after()`, `loop()`, `sleep()`, `on()`, `goto()`, `movements()`, `createReport()` ; tout est nettoyé automatiquement à l'arrêt du mode ou à la déconnexion.

**Ajouter un nœud** : ajoutez une définition `{ type, category, label, description, outputs, params, run(api) }` (ou `subscribe(api, fire)` pour un évènement) dans `src/graph/nodes/*.js`. `api.param('clé')` résout les expressions, `api.bot`, `api.locals`, `api.setVar()`, `api.sleep()`, `api.exec('sortie')`, `api.report` sont disponibles. Le nœud apparaît automatiquement dans la palette.

```bash
npm test     # tests unitaires (expressions, moteur de graphes, registres, exemples)
```

## Licence

[AGPL-3.0](LICENSE)
