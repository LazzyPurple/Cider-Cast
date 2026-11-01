# Composants tiers

- **Node.js 24.21.0** — exécutable Windows x64 vérifié contre les SHA-256 officiels. Licence et notices complètes dans `app/runtime/NODE-LICENSE.txt`. Source : https://nodejs.org/dist/v24.21.0/.
- **Microsoft .NET 10.0.14** — runtime privé issu du SDK officiel 10.0.403, archive vérifiée par SHA-512. Licence et notices dans `app/runtime/dotnet/LICENSE.txt` et `ThirdPartyNotices.txt`. Source : https://builds.dotnet.microsoft.com/dotnet/release-metadata/10.0/releases.json.
- **Classic Chromecast caster**, Rik van der Reijen — transport RTP/RTCP adapté, commit `6cd9fdd1c7b1ca7d88f1023eff4f13a3032c5bab`, Apache-2.0. Sources adaptées, licence et notice dans `sources/sender/vendor/`. Modifications locales : compatibilité du runtime, contrôles de trames/retours, priorités, continuité, reprise UDP bornée et diagnostics numériques.
- **Concentus 2.2.2** — codec Opus géré, BSD-3-Clause ; licence dans `licenses/Concentus-LICENSE.txt`. https://www.nuget.org/packages/Concentus/2.2.2.
- **castv2**, **multicast-dns**, **dns-packet**, **@leichtgewicht/ip-codec**, **protobufjs**, **long**, **thunky** et leurs dépendances — licences conservées à côté de chaque paquet dans `app/cider-marshall-isolated/node_modules/`. Versions et intégrités verrouillées dans `package-lock.json`.
- Le contrat de routage Windows interne est référencé depuis le projet **EarTrumpet** : https://github.com/File-New-Project/EarTrumpet. Cette API reste dépendante de Windows ; le plugin n’est pas un composant officiel de Microsoft ou de Cider.
- **FFplay / FFmpeg** n’est pas redistribué dans cette archive. Une installation existante est réutilisée, ou WinGet installe le paquet `Gyan.FFmpeg` après confirmation. Sources, licences et conditions : https://www.gyan.dev/ffmpeg/builds/ et https://ffmpeg.org/legal.html.

Google Cast, Cider et Marshall désignent leurs produits respectifs. Ce plugin local ne prétend pas à une certification de ces éditeurs. L’identité interne historique du plugin est conservée pour éviter des installations en double lors d’une mise à jour.
