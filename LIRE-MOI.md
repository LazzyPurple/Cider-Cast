# Cider Cast — service audio Windows

Ce paquet installe le compagnon Windows du plugin Cider Cast. Il ne remplace pas le plugin installé depuis Cider.

1. Installer Cider Cast dans Cider, puis fermer complètement Cider.
2. Ouvrir l’installateur Windows du service. Node et .NET sont inclus ; aucun pilote supplémentaire n’est installé.
3. Rouvrir Cider, puis Sortie audio. La connexion au service est configurée automatiquement, sans clé à copier.
4. Avec la roue dentée, choisir une sortie Windows inutilisée, qui restera connectée et réservée à Cider.
5. Choisir les enceintes Cast et lancer la musique.

Windows 11 x64 et Cider Microsoft Store 4.0.32 minimum sont requis. Le service reste local au PC. Si FFplay manque, l’installation propose Gyan.FFmpeg via WinGet et demande d’accepter ses accords. Une connexion Internet est alors nécessaire.

Le plugin et le service portent la même version. Mettez à jour le plugin dans Cider, fermez Cider puis mettez à jour le service si le plugin le demande. Une récupération Windows en attente doit être terminée avec l’ancienne version avant remplacement. Les configurations, connexions et sauvegardes personnelles ne doivent pas être partagées.

La connexion est enregistrée uniquement sur le PC. Une mise à jour Marketplace peut retirer son fichier d’origine : le plugin conserve aussi l’association dans le stockage local de Cider. Réinstaller le service renouvelle l’association si nécessaire. Aucune API publique ne fournit le jeton sans authentification.

Desinstaller.js retire le démarrage automatique et la connexion au service ; le plugin reste géré par Cider. Retour-Version-Precedente.js récupère la sauvegarde précédente, s’il y en a une. Fermer Cider et terminer toute restauration avant ces opérations. Les sauvegardes restent dans LocalAppData/CiderCast.

Le ZIP contient les mêmes fichiers pour une installation manuelle avec Installer.js. Installer.ps1 -Action Check vérifie le paquet sans modifier l’installation.

Cette version 1.0.0-rc.2 est une candidate de test. L’installation sur Windows vierge et une longue écoute restent à qualifier. L’installateur n’est pas signé par un éditeur ; la publication du ZIP ne constitue pas une approbation du Marketplace.
