# Fiche de soumission Marketplace

Cette fiche prépare la soumission ; elle ne prouve pas qu'un projet est déjà accepté ou indexé. L'entrée officielle pour les créateurs est https://marketplace.cider.sh/create-project, accessible depuis le site Marketplace.

- Nom : **Cider Cast**
- Auteur : **LazzyPurple**
- Type : **Plugin**
- Version : **1.0.0-rc.2**, candidate de test
- Identifiant stable : **local.marshall-cast**
- Dépôt et assistance : https://github.com/LazzyPurple/Cider-Cast
- Licence : MIT ; notices tierces dans le dépôt et le service
- Archive du plugin : https://github.com/LazzyPurple/Cider-Cast/releases/download/v1.0.0-rc.2/Cider-Cast-1.0.0-rc.2.zip
- Service Windows : https://github.com/LazzyPurple/Cider-Cast/releases/download/v1.0.0-rc.2/Cider-Cast-Service-1.0.0-rc.2-Windows-x64.exe
- Configuration requise : Windows 11 x64, Cider Microsoft Store 4.0.32 minimum, sortie Windows inutilisée et réseau local permettant Cast

## Description courte

Diffusez uniquement Cider vers vos enceintes Google Cast. Choix des appareils dans Sortie audio, volume avec les commandes natives et retour PC. Un service Windows gratuit est nécessaire à la première installation.

## Description détaillée

Cider Cast ajoute un sélecteur d'enceintes et de groupes Google Cast à Cider. Les autres applications restent sur le PC. Lecture, pause, précédent, suivant et progression restent dans les commandes natives de Cider.

Au premier lancement, le plugin guide l'installation du service Windows. Fermez Cider, lancez l'installateur puis rouvrez Cider : la connexion est automatique, sans clé à copier. Choisissez une sortie Windows inutilisée avec la roue dentée, connectez vos enceintes puis lancez la musique.

Aucun pilote audio supplémentaire n'est installé. Node et .NET sont inclus. FFmpeg est proposé via WinGet uniquement si FFplay manque. Les mises à jour du service se font Cider fermé, avec sauvegarde. Le service écoute uniquement sur la boucle locale et exige une connexion personnelle générée sur le PC.

Version candidate : installation Windows vierge et écoute longue durée encore à qualifier. L'installateur n'est pas signé par un éditeur. Ce plugin communautaire n'est pas certifié par Cider, Google ou Marshall. Une capture d'écran simulée du parcours initial est disponible dans docs/first-install-preview.png.

## Soumission

Se connecter au compte créateur du Marketplace, créer un projet de type Plugin, reprendre ces informations et fournir le ZIP du plugin. Ne pas fournir le ZIP ou l'EXE du service comme archive de plugin. Respecter les étapes et conditions présentées par le site ; une connexion et une validation de l'éditeur peuvent rester nécessaires.
