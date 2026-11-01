# Cider Cast

Diffusez uniquement la musique de Cider vers vos enceintes et groupes Google Cast. Les autres applications restent sur le PC.

**Version candidate 1.0.0-rc.2 — Windows 11 x64, Cider Microsoft Store 4.0.32 ou plus récent.** Ce projet communautaire n'est pas un plugin officiel de Cider ou de Google. La publication GitHub ne vaut pas approbation Marketplace.

## Installation

1. Installez le plugin dans Cider. Tant que le Marketplace ne le référence pas, utilisez le [ZIP du plugin](https://github.com/LazzyPurple/Cider-Cast/releases/download/v1.0.0-rc.2/local.marshall-cast-1.0.0-rc.2.zip) avec l'importeur ZIP de Cider.
2. Ouvrez Sortie audio → **Installer le service Windows**. Fermez Cider, puis ouvrez [l'installateur du service](https://github.com/LazzyPurple/Cider-Cast/releases/download/v1.0.0-rc.2/Cider-Cast-Service-1.0.0-rc.2-Windows-x64.exe).
3. Rouvrez Cider. La connexion au service est configurée automatiquement : aucune clé à copier.
4. Avec la roue dentée de Sortie audio, choisissez une sortie Windows inutilisée et disponible, qui restera réservée à Cider.
5. Choisissez vos enceintes Cast, puis lancez la musique.

Pas de pilote virtuel supplémentaire. Node et .NET sont inclus dans le service, sans installation globale. Si FFplay manque, l'installateur propose FFmpeg via WinGet et annonce ses accords avant confirmation. Le PC et les enceintes doivent communiquer sur le réseau local ; le pare-feu n'est pas modifié automatiquement.

## Usage

- La barre de volume native commande le volume des enceintes ; le signal de Cider reste réglé à 60 % de son niveau natif pendant Cast.
- Lecture, pause, précédent, suivant, progression et file d'attente restent dans Cider.
- Cet ordinateur permet le retour PC. Le niveau PC précédent est conservé.
- Fermez Cider avant de mettre à jour le service. Terminez toute restauration de l'ancienne sortie avant remplacement.
- L'installateur du service conserve les fichiers du plugin gérés par Cider. La connexion personnelle est créée localement et sauvegardée dans le stockage de Cider pour résister aux mises à jour du plugin. Une réinstallation du service répare l'association si nécessaire.
- Le retrait du service conserve les sauvegardes et laisse le plugin sous le contrôle de Cider. Les scripts de retrait et de retour arrière se trouvent dans LocalAppData/CiderCast.

Le choix de sortie Windows est nécessaire : elle doit rester connectée et ne doit pas être la sortie Windows par défaut ni être utilisée par une autre application. En cas d'identité Windows ambiguë ou de sortie absente, aucune sortie de remplacement n'est choisie arbitrairement.

## Confidentialité et limites

Le service écoute uniquement sur 127.0.0.1 et exige un jeton local. Aucun jeton, identifiant de sortie personnel ou journal musical n'est publié. Les diagnostics locaux sont limités aux états et compteurs autorisés. Ne partagez pas votre dossier LocalAppData/CiderCast.

L'installateur n'est pas signé par un éditeur. La paire Marshall utilisée pour le développement a été essayée ; les autres appareils Cast nécessitent leur propre validation. La synchronisation du volume natif dépend encore de propriétés internes de Cider 4. Les essais automatiques et retours réseau ne garantissent pas l'absence de microcoupures audibles.

## Développement et construction

Prérequis : Windows 11 x64, Node 24, Python 3, .NET SDK 10, Visual Studio C++ Build Tools avec SDK Windows. Aucune installation audio n'est effectuée par la construction.

```powershell
npm ci --ignore-scripts
.\Build.ps1
$env:CIDER_CAST_FFPLAY = (Get-Command ffplay.exe).Source
npm test
npm run test:installer
```

Build.ps1 restaure les dépendances verrouillées, compile la capture et l'émetteur, vérifie les runtimes officiels par empreinte et crée dans dist le ZIP Marketplace, le ZIP de dépannage du service et son installateur EXE. L'option RuntimeCache accepte uniquement les fichiers correspondant aux empreintes verrouillées ; elle est utile pour réutiliser un téléchargement vérifié. La distribution doit être préservée avant une nouvelle construction.

Les tests d'installation utilisent de faux profils et de fausses tâches Windows. Le test de l'EXE extrait le vrai paquet sans l'installer. Les essais réseau de l'émetteur utilisent la boucle locale et du son synthétique, pas la musique de l'utilisateur.

## État de publication

Le ZIP place plugin.yml et les modules à sa racine, comme le modèle officiel. Le service est un téléchargement séparé. La mise en ligne Marketplace et l'installation sur un Windows vierge restent à valider avant une V1 stable. Ne soumettez pas le ZIP du service à l'importeur de plugins.

Voir [les résultats et limites de validation](docs/VALIDATION.md), [la fiche de soumission Marketplace](docs/MARKETPLACE.md), [les composants tiers](THIRD-PARTY-NOTICES.md), [la procédure du service](LIRE-MOI.md) et la licence MIT du dépôt.
