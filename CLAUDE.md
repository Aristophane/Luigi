# Luigi — Instructions de projet

## Design Context

### Users

La V1 est utilisée par un administrateur unique qui supervise ses applications, ses dépôts GitHub et un VPS Ubuntu 24.04. Son objectif est de vérifier rapidement que tout fonctionne, comprendre l'origine d'une anomalie et traiter les tâches de maintenance sans parcourir plusieurs outils spécialisés.

Les usages principaux sont la supervision de la disponibilité, des ressources et de la sécurité du VPS, le suivi des dépendances et vulnérabilités, les notifications internes et Web Push, la gestion des tâches de maintenance et l'ajout d'applications avec détection des technologies depuis GitHub.

### Brand Personality

Sobre, informative et apaisante.

L'interface inspire la maîtrise et la continuité. En fonctionnement normal, elle communique explicitement le calme et la fraîcheur des données. En cas d'incident, elle devient claire et actionnable sans dramatisation.

La voix est concise, factuelle et rassurante. Elle indique ce qui se passe, l'impact probable et la prochaine action utile.

### Aesthetic Direction

L'esthétique s'inspire de Railway sans la reproduire : infrastructure moderne, dense mais lisible, hiérarchie nette, surfaces maîtrisées et détails techniques élégants.

Le motif distinctif est un réseau ferroviaire vivant. Projets, applications et services peuvent être représentés comme des stations reliées par des rails. Une petite machine ou un signal se déplace lentement quand le système est sain. Ce mouvement doit toujours représenter une donnée réelle : collecte, heartbeat, déploiement ou circulation entre une source et le cockpit.

Les modes clair et sombre sont tous deux requis. Les couleurs d'état sont strictement fonctionnelles : vert pour sain, ambre pour attention, rouge pour incident et neutre pour inconnu ou suspendu. Éviter le noir et le blanc purs.

Éviter l'esthétique terminal cyberpunk, les néons, les gradients bleu-violet génériques, les grilles monotones de cartes, le glassmorphism décoratif et la surutilisation d'icônes.

### Design Principles

1. **Le calme est explicite.** Montrer la fraîcheur des données et une preuve de vie discrète plutôt qu'une accumulation d'indicateurs verts.
2. **Le mouvement explique.** Le rail animé correspond à une collecte, un heartbeat ou une progression réelle et respecte `prefers-reduced-motion`.
3. **L'anomalie mène à une action.** Chaque signal indique l'impact, la preuve, la ressource et la prochaine étape.
4. **La densité reste lisible.** Utiliser une hiérarchie forte, des regroupements clairs et la divulgation progressive plutôt que des cartes répétitives.
5. **La couleur garde son sens.** Ne pas employer les couleurs d'état comme décoration et toujours doubler la couleur par du texte ou une forme.
6. **Les deux thèmes sont de première classe.** Vérifier le contraste et la lisibilité en clair comme en sombre, avec un objectif WCAG 2.2 AA.
7. **La sérénité n'efface pas l'urgence.** Le fonctionnement normal est apaisant ; les incidents critiques sont immédiatement visibles sans animation agressive.


<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
