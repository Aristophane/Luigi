import type { MaintenanceTask } from "@/lib/domain";

type Category = MaintenanceTask["category"];

const defaults: Record<Category, { remediation: string[]; verification: string[]; impact: string }> = {
  security: {
    impact: "Une configuration ou une version exposée peut augmenter le risque d’accès non autorisé ou de compromission.",
    remediation: [
      "Confirmer un accès de secours et l’état des sauvegardes avant toute modification.",
      "Appliquer le correctif ou durcir la configuration pendant une fenêtre contrôlée.",
      "Noter la version ou le réglage obtenu dans le journal de maintenance.",
    ],
    verification: [
      "Relancer la source de détection et confirmer que le signal a disparu.",
      "Vérifier l’accès d’administration et la disponibilité des applications concernées.",
    ],
  },
  dependency: {
    impact: "Une dépendance ancienne peut contenir un défaut corrigé ou devenir incompatible avec les versions maintenues.",
    remediation: [
      "Lire le changelog et identifier les changements incompatibles.",
      "Mettre à jour le manifeste et le fichier de verrouillage dans une branche dédiée.",
      "Exécuter les tests puis déployer selon le processus habituel.",
    ],
    verification: [
      "Confirmer la version réellement déployée.",
      "Relancer les contrôles de santé et l’analyse des dépendances.",
    ],
  },
  capacity: {
    impact: "Une ressource saturée peut dégrader les réponses, interrompre les déploiements ou arrêter les services.",
    remediation: [
      "Identifier la ressource et le processus responsables de la croissance.",
      "Sauvegarder ce qui doit l’être avant tout nettoyage manuel.",
      "Réduire l’usage ou augmenter la capacité avec une marge durable.",
    ],
    verification: [
      "Comparer la mesure après intervention au seuil ayant déclenché l’alerte.",
      "Observer au moins deux collectes successives sans nouvelle hausse anormale.",
    ],
  },
  backup: {
    impact: "Une sauvegarde absente ou non restaurable allonge fortement la reprise après incident.",
    remediation: [
      "Identifier la dernière sauvegarde complète et consulter le journal d’échec.",
      "Relancer une sauvegarde vers un stockage distinct du VPS.",
      "Effectuer une restauration de contrôle sans écraser les données actives.",
    ],
    verification: [
      "Conserver la date, la taille et le résultat du test de restauration.",
      "Confirmer que la prochaine exécution planifiée est active.",
    ],
  },
  lifecycle: {
    impact: "Une opération non planifiée peut provoquer une interruption ou laisser un composant dans un état non maintenu.",
    remediation: [
      "Définir la fenêtre, le retour arrière et les services potentiellement impactés.",
      "Vérifier les sauvegardes puis exécuter l’opération prévue.",
      "Documenter tout écart rencontré pendant l’intervention.",
    ],
    verification: [
      "Confirmer le redémarrage des services attendus.",
      "Exécuter les contrôles applicatifs et surveiller les métriques après intervention.",
    ],
  },
};

export function maintenanceGuidance(task: Pick<MaintenanceTask, "title" | "category" | "description" | "remediation" | "verification">) {
  const fallback = defaults[task.category];
  const specific = specificGuidance(task.title);
  return {
    impact: task.description?.trim() || fallback.impact,
    remediation: task.remediation?.split(/\r?\n/).map((step) => step.trim()).filter(Boolean) ?? specific?.remediation ?? fallback.remediation,
    verification: task.verification?.split(/\r?\n/).map((step) => step.trim()).filter(Boolean) ?? specific?.verification ?? fallback.verification,
  };
}

function specificGuidance(title: string) {
  const value = title.toLowerCase();
  if (value.includes("correctifs de sécurité")) return {
    remediation: ["Actualiser l’index APT et lire la liste des paquets concernés.", "Vérifier les changements incompatibles et l’état des sauvegardes.", "Installer les correctifs dans une fenêtre contrôlée sans forcer la suppression de paquets.", "Planifier un redémarrage si le système le demande."],
    verification: ["Confirmer qu’APT ne signale plus de correctif de sécurité.", "Vérifier les services systemd en échec et lancer les contrôles HTTP des applications."],
  };
  if (value.includes("ufw")) return {
    remediation: ["Inventorier les ports réellement écoutés et ceux publiés par Docker/Coolify.", "Autoriser explicitement l’accès SSH utilisé avant d’activer une politique entrante restrictive.", "Appliquer les règles depuis une session conservée ouverte avec un second accès de secours."],
    verification: ["Contrôler l’état détaillé d’UFW et les ports exposés depuis l’extérieur.", "Ouvrir une seconde connexion SSH et vérifier les applications avant de fermer la session initiale."],
  };
  if (value.includes("ssh") && value.includes("mot de passe")) return {
    remediation: ["Confirmer qu’au moins une clé SSH administrateur fonctionne avec sudo dans une seconde session.", "Désactiver PasswordAuthentication dans un fichier dédié de sshd_config.d.", "Valider la syntaxe SSH avant de recharger le service, sans fermer la session courante."],
    verification: ["Ouvrir une nouvelle session avec la clé attendue.", "Confirmer qu’une tentative par mot de passe est refusée et que Luigi retrouve le réglage sécurisé."],
  };
  if (value.includes("ssh") && value.includes("root")) return {
    remediation: ["Créer ou confirmer un compte administrateur nominatif avec clé SSH et sudo.", "Tester cet accès dans une seconde session.", "Désactiver PermitRootLogin, valider la configuration puis recharger SSH."],
    verification: ["Confirmer l’accès du compte administrateur et son élévation sudo.", "Vérifier que la connexion SSH directe de root est refusée."],
  };
  if (value.includes("espace") || value.includes("disque")) return {
    remediation: ["Ouvrir l’explorateur disque Luigi et comparer les deux derniers inventaires.", "Identifier les journaux, volumes, images ou sauvegardes responsables avant toute suppression.", "Sauvegarder les données utiles puis nettoyer depuis Coolify ou le VPS avec une cible explicite."],
    verification: ["Relancer l’inventaire et confirmer une marge durable sous le seuil d’alerte.", "Vérifier les bases, volumes et applications liés aux éléments modifiés."],
  };
  if (value.includes("pression mémoire")) return {
    remediation: ["Identifier le service qui consomme la mémoire et distinguer charge stable, fuite et cache récupérable.", "Consulter ses journaux et limites avant de le redémarrer ou de modifier sa mémoire.", "Corriger la cause ou ajuster prudemment les limites de ressources."],
    verification: ["Observer au moins trois collectes sous le seuil d’alerte.", "Confirmer l’absence de redémarrages en boucle et la latence normale des applications."],
  };
  if (value.includes("redémarrage")) return {
    remediation: ["Choisir une fenêtre et vérifier une sauvegarde récente.", "Recenser les applications impactées et définir le retour arrière.", "Redémarrer puis attendre que les services aient fini leur initialisation."],
    verification: ["Vérifier les services systemd en échec, le proxy et les conteneurs Coolify.", "Lancer tous les contrôles HTTP et confirmer que le redémarrage n’est plus requis."],
  };
  if (value.includes("sauvegarde")) return {
    remediation: ["Lire le journal de la dernière exécution et corriger sa cause précise.", "Relancer une sauvegarde complète vers un stockage hors du VPS.", "Restaurer un échantillon ou une copie isolée, sans écraser la production."],
    verification: ["Conserver la preuve horodatée du test de restauration.", "Confirmer la prochaine planification et la mise à jour du marqueur suivi par Luigi."],
  };
  if (value.includes("paquets ubuntu retenus")) return {
    remediation: ["Lister les paquets retenus et identifier la raison de chaque blocage.", "Lire les changements et vérifier la compatibilité avec Docker, Coolify et les applications.", "Retirer la retenue uniquement dans une fenêtre permettant un retour arrière."],
    verification: ["Confirmer les versions installées et l’absence de dépendance cassée.", "Vérifier les services et les contrôles applicatifs après mise à jour."],
  };
  return null;
}
