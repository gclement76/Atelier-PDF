// =====================================================================
// Atelier PDF : fusionner, réorganiser, pivoter, supprimer, extraire
// Tout se passe dans le navigateur : aucun fichier n'est envoyé.
// =====================================================================

// pdf.js a besoin d'un « worker » (programme en arrière-plan) pour lire les PDF
pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

const { PDFDocument, degrees } = PDFLib;

// Couleurs attribuées aux fichiers (une par fichier, en boucle)
const COULEURS = ['#22d3ee', '#a78bfa', '#f472b6', '#facc15', '#34d399'];

// ----- État de l'application -----
// fichiers : idFichier -> { nom, octets, docPdfjs, couleur }
const fichiers = new Map();
// pages : liste ordonnée des pages du futur PDF
//   { id, idFichier, numero (0 = 1re page du fichier), rotation (0/90/180/270), selectionnee,
//     ajouts (textes, rectangles, images posés par-dessus : voir editeur.js) }
let pages = [];
// cartes : id de page -> élément HTML de sa miniature (pour ne pas tout redessiner)
const cartes = new Map();
let compteurId = 0;
let compteurFichiers = 0;
let idPageGlissee = null; // page en cours de déplacement (glisser-déposer)

// ----- Éléments de la page -----
const zoneDepot = document.getElementById('zoneDepot');
const champFichiers = document.getElementById('champFichiers');
const listeFichiers = document.getElementById('listeFichiers');
const barreActions = document.getElementById('barreActions');
const compteurPages = document.getElementById('compteurPages');
const grillePages = document.getElementById('grillePages');
const zoneMessage = document.getElementById('message');
const aide = document.getElementById('aide');
const champNom = document.getElementById('champNom');

// =====================================================================
// Messages à l'utilisateur
// =====================================================================
function afficherMessage(texte, estErreur = false) {
  zoneMessage.textContent = texte;
  zoneMessage.classList.toggle('erreur', estErreur);
}

// =====================================================================
// Ajout de fichiers PDF
// =====================================================================
async function ajouterFichiers(listeChoisie) {
  const erreurs = [];
  for (const fichier of listeChoisie) {
    if (!fichier.name.toLowerCase().endsWith('.pdf')) {
      erreurs.push(`« ${fichier.name} » n'est pas un PDF`);
      continue;
    }
    afficherMessage(`Lecture de « ${fichier.name} »…`);
    try {
      const octets = new Uint8Array(await fichier.arrayBuffer());
      // pdf.js « consomme » les octets qu'on lui donne : on lui passe une copie
      const docPdfjs = await pdfjsLib.getDocument({ data: octets.slice() }).promise;
      const idFichier = ++compteurId;
      fichiers.set(idFichier, {
        nom: fichier.name,
        octets,
        docPdfjs,
        couleur: COULEURS[compteurFichiers++ % COULEURS.length],
      });
      for (let numero = 0; numero < docPdfjs.numPages; numero++) {
        pages.push({ id: ++compteurId, idFichier, numero, rotation: 0, selectionnee: false, ajouts: [] });
      }
    } catch (erreur) {
      console.error(erreur);
      const raison = erreur.name === 'PasswordException' ? 'protégé par un mot de passe' : 'illisible';
      erreurs.push(`« ${fichier.name} » est ${raison}`);
    }
  }
  afficherTout();
  if (erreurs.length) afficherMessage(erreurs.join(' · '), true);
  else afficherMessage(`${pages.length} page(s) au total.`);
}

// =====================================================================
// Affichage
// =====================================================================
function afficherTout() {
  afficherListeFichiers();
  afficherPages();
  mettreAJourBoutons();
}

// Liste des fichiers en haut (seulement ceux qui ont encore des pages)
function afficherListeFichiers() {
  listeFichiers.innerHTML = '';
  for (const [idFichier, fichier] of fichiers) {
    const nbPages = pages.filter((p) => p.idFichier === idFichier).length;
    if (nbPages === 0) continue;
    const element = document.createElement('li');
    element.style.setProperty('--couleur', fichier.couleur);
    element.textContent = `${fichier.nom} — ${nbPages} page(s)`;
    listeFichiers.appendChild(element);
  }
}

// Grille des miniatures, dans l'ordre du tableau « pages »
function afficherPages() {
  // Supprime les cartes des pages qui n'existent plus
  const idsExistants = new Set(pages.map((p) => p.id));
  for (const [id, carte] of cartes) {
    if (!idsExistants.has(id)) {
      carte.remove();
      cartes.delete(id);
    }
  }
  // Crée les cartes manquantes et les range dans le bon ordre
  pages.forEach((page, position) => {
    let carte = cartes.get(page.id);
    if (!carte) {
      carte = creerCarte(page);
      cartes.set(page.id, carte);
    }
    carte.querySelector('.position').textContent = position + 1;
    carte.classList.toggle('selectionnee', page.selectionnee);
    carte.querySelector('.case').checked = page.selectionnee;
    grillePages.appendChild(carte); // appendChild déplace la carte si elle existe déjà
  });
}

function creerCarte(page) {
  const fichier = fichiers.get(page.idFichier);
  const carte = document.createElement('article');
  carte.className = 'carte';
  carte.draggable = true;
  carte.dataset.id = page.id;
  carte.style.setProperty('--couleur', fichier.couleur);
  carte.innerHTML = `
    <input class="case" type="checkbox" title="Sélectionner cette page">
    <div class="vignette"><canvas></canvas></div>
    <div class="infos">
      <span class="position"></span>
      <span class="origine" title="${echapper(fichier.nom)}">${echapper(fichier.nom)} · p. ${page.numero + 1}</span>
    </div>
    <div class="outils">
      <button type="button" data-action="gauche" title="Déplacer vers la gauche">←</button>
      <button type="button" data-action="pivoter-gauche" title="Pivoter à gauche">↺</button>
      <button type="button" data-action="pivoter-droite" title="Pivoter à droite">↻</button>
      <button type="button" data-action="modifier" title="Modifier : texte, rectangle, image, signature">✎</button>
      <button type="button" data-action="supprimer" title="Supprimer la page" class="danger">✕</button>
      <button type="button" data-action="droite" title="Déplacer vers la droite">→</button>
    </div>`;
  dessinerVignette(page, carte.querySelector('canvas'));
  return carte;
}

// Évite qu'un nom de fichier contenant < ou > casse l'affichage
function echapper(texte) {
  const div = document.createElement('div');
  div.textContent = texte;
  return div.innerHTML;
}

// Dessine la miniature d'une page dans un canvas, avec sa rotation
const tachesDessin = new Map(); // id de page -> dessin en cours (pour l'annuler)
async function dessinerVignette(page, canvas) {
  tachesDessin.get(page.id)?.cancel();
  const pagePdfjs = await fichiers.get(page.idFichier).docPdfjs.getPage(page.numero + 1);
  const rotationTotale = (pagePdfjs.rotate + page.rotation) % 360;
  const vueTaille1 = pagePdfjs.getViewport({ scale: 1, rotation: rotationTotale });
  // Taille de la miniature : 300 pixels sur le plus grand côté
  const echelle = 300 / Math.max(vueTaille1.width, vueTaille1.height);
  const vue = pagePdfjs.getViewport({ scale: echelle, rotation: rotationTotale });
  canvas.width = Math.round(vue.width);
  canvas.height = Math.round(vue.height);
  const tache = pagePdfjs.render({ canvasContext: canvas.getContext('2d'), viewport: vue });
  tachesDessin.set(page.id, tache);
  try {
    await tache.promise;
    // Dessine par-dessus les éléments ajoutés dans l'éditeur
    const { w, h } = dimensions(pagePdfjs);
    dessinerAjouts(canvas.getContext('2d'), page.ajouts, echelle, rotationTotale, w, h);
  } catch (erreur) {
    if (erreur.name !== 'RenderingCancelledException') console.error(erreur);
  }
}

function mettreAJourBoutons() {
  const nbSelection = pages.filter((p) => p.selectionnee).length;
  barreActions.hidden = pages.length === 0;
  aide.hidden = pages.length === 0;
  compteurPages.textContent = `${pages.length} page(s)` + (nbSelection ? ` · ${nbSelection} sélectionnée(s)` : '');
  document.getElementById('btnSupprimerSelection').disabled = nbSelection === 0;
  document.getElementById('btnPivoterSelection').disabled = nbSelection === 0;
  document.getElementById('btnExtraire').disabled = nbSelection === 0;
  document.getElementById('btnToutDeselectionner').disabled = nbSelection === 0;
}

// =====================================================================
// Actions sur les pages
// =====================================================================
function trouverPage(id) {
  return pages.find((p) => p.id === id);
}

function pivoter(page, angle) {
  page.rotation = (page.rotation + angle + 360) % 360;
  dessinerVignette(page, cartes.get(page.id).querySelector('canvas'));
}

function deplacer(id, decalage) {
  const index = pages.findIndex((p) => p.id === id);
  const nouvelIndex = index + decalage;
  if (nouvelIndex < 0 || nouvelIndex >= pages.length) return;
  const [page] = pages.splice(index, 1);
  pages.splice(nouvelIndex, 0, page);
  afficherTout();
}

function supprimerPages(ids) {
  pages = pages.filter((p) => !ids.includes(p.id));
  afficherTout();
  afficherMessage(`${ids.length} page(s) supprimée(s).`);
}

// Clics dans la grille : boutons d'outils, case à cocher, ou clic sur la carte
grillePages.addEventListener('click', (evenement) => {
  const carte = evenement.target.closest('.carte');
  if (!carte) return;
  const page = trouverPage(Number(carte.dataset.id));
  const bouton = evenement.target.closest('button');

  if (bouton) {
    switch (bouton.dataset.action) {
      case 'gauche': deplacer(page.id, -1); break;
      case 'droite': deplacer(page.id, 1); break;
      case 'pivoter-gauche': pivoter(page, -90); break;
      case 'pivoter-droite': pivoter(page, 90); break;
      case 'supprimer': supprimerPages([page.id]); break;
      case 'modifier': ouvrirEditeur(page); break;
    }
    return;
  }
  // Clic sur la case ou ailleurs sur la carte : (dé)sélectionne la page
  page.selectionnee = !page.selectionnee;
  afficherPages();
  mettreAJourBoutons();
});

// Double-clic sur une miniature : ouvre l'éditeur de la page
grillePages.addEventListener('dblclick', (evenement) => {
  const carte = evenement.target.closest('.carte');
  if (!carte || evenement.target.closest('button, input')) return;
  ouvrirEditeur(trouverPage(Number(carte.dataset.id)));
});

// ----- Boutons de la barre d'actions -----
document.getElementById('btnToutSelectionner').addEventListener('click', () => {
  pages.forEach((p) => (p.selectionnee = true));
  afficherTout();
});

document.getElementById('btnToutDeselectionner').addEventListener('click', () => {
  pages.forEach((p) => (p.selectionnee = false));
  afficherTout();
});

document.getElementById('btnPivoterSelection').addEventListener('click', () => {
  pages.filter((p) => p.selectionnee).forEach((p) => pivoter(p, 90));
});

document.getElementById('btnSupprimerSelection').addEventListener('click', () => {
  supprimerPages(pages.filter((p) => p.selectionnee).map((p) => p.id));
});

document.getElementById('btnToutEffacer').addEventListener('click', () => {
  if (!confirm('Retirer toutes les pages ? (vos fichiers d\'origine ne sont pas touchés)')) return;
  pages = [];
  fichiers.clear();
  afficherTout();
  afficherMessage('');
});

document.getElementById('btnTelecharger').addEventListener('click', () => {
  exporter(pages, champNom.value);
});

document.getElementById('btnExtraire').addEventListener('click', () => {
  exporter(pages.filter((p) => p.selectionnee), champNom.value + '-extrait');
});

// =====================================================================
// Glisser-déposer pour réordonner les pages
// =====================================================================
function effacerIndicateurs() {
  grillePages.querySelectorAll('.cible-avant, .cible-apres')
    .forEach((c) => c.classList.remove('cible-avant', 'cible-apres'));
}

// La souris est-elle sur la moitié gauche de la carte ? (on dépose alors avant elle)
function estAvant(evenement, carte) {
  const rectangle = carte.getBoundingClientRect();
  return evenement.clientX < rectangle.left + rectangle.width / 2;
}

grillePages.addEventListener('dragstart', (evenement) => {
  const carte = evenement.target.closest('.carte');
  if (!carte) return;
  idPageGlissee = Number(carte.dataset.id);
  carte.classList.add('en-deplacement');
  evenement.dataTransfer.effectAllowed = 'move';
  evenement.dataTransfer.setData('text/plain', String(idPageGlissee));
});

grillePages.addEventListener('dragover', (evenement) => {
  if (idPageGlissee === null) return;
  const carte = evenement.target.closest('.carte');
  evenement.preventDefault(); // autorise le dépôt
  effacerIndicateurs();
  if (carte && Number(carte.dataset.id) !== idPageGlissee) {
    carte.classList.add(estAvant(evenement, carte) ? 'cible-avant' : 'cible-apres');
  }
});

grillePages.addEventListener('drop', (evenement) => {
  if (idPageGlissee === null) return;
  evenement.preventDefault();
  const carte = evenement.target.closest('.carte');
  if (carte && Number(carte.dataset.id) !== idPageGlissee) {
    const avant = estAvant(evenement, carte);
    const page = pages.splice(pages.findIndex((p) => p.id === idPageGlissee), 1)[0];
    let index = pages.findIndex((p) => p.id === Number(carte.dataset.id));
    if (!avant) index++;
    pages.splice(index, 0, page);
    afficherTout();
  }
});

grillePages.addEventListener('dragend', () => {
  cartes.get(idPageGlissee)?.classList.remove('en-deplacement');
  idPageGlissee = null;
  effacerIndicateurs();
});

// =====================================================================
// Ajout de fichiers : bouton ou glisser-déposer depuis l'Explorateur
// =====================================================================
champFichiers.addEventListener('change', () => {
  ajouterFichiers([...champFichiers.files]);
  champFichiers.value = ''; // permet de rechoisir le même fichier
});

// On accepte les fichiers déposés n'importe où dans la fenêtre
function contientDesFichiers(evenement) {
  return evenement.dataTransfer && [...evenement.dataTransfer.types].includes('Files');
}

window.addEventListener('dragover', (evenement) => {
  if (!contientDesFichiers(evenement)) return;
  evenement.preventDefault();
  zoneDepot.classList.add('survol');
});

window.addEventListener('dragleave', (evenement) => {
  if (evenement.relatedTarget === null) zoneDepot.classList.remove('survol');
});

window.addEventListener('drop', (evenement) => {
  if (!contientDesFichiers(evenement)) return;
  evenement.preventDefault(); // sinon le navigateur ouvre le PDF à la place de la page
  zoneDepot.classList.remove('survol');
  ajouterFichiers([...evenement.dataTransfer.files]);
});

// =====================================================================
// Création du PDF final avec pdf-lib
// =====================================================================
async function construirePdf(pagesAExporter) {
  const docFinal = await PDFDocument.create();

  // Copie les pages fichier par fichier (une seule copie par fichier :
  // les polices et images partagées ne sont pas dupliquées → fichier plus léger)
  const pagesCopiees = new Map(); // id de page -> page copiée
  for (const idFichier of new Set(pagesAExporter.map((p) => p.idFichier))) {
    const docSource = await PDFDocument.load(fichiers.get(idFichier).octets, { ignoreEncryption: true });
    const pagesDuFichier = pagesAExporter.filter((p) => p.idFichier === idFichier);
    const copies = await docFinal.copyPages(docSource, pagesDuFichier.map((p) => p.numero));
    pagesDuFichier.forEach((p, i) => pagesCopiees.set(p.id, copies[i]));
  }

  // Ajoute les pages dans l'ordre choisi, avec leur rotation et leurs ajouts
  const ressources = { polices: {}, images: new Map() };
  for (const page of pagesAExporter) {
    const copie = pagesCopiees.get(page.id);
    if (page.rotation) {
      const angle = (((copie.getRotation().angle + page.rotation) % 360) + 360) % 360;
      copie.setRotation(degrees(angle));
    }
    docFinal.addPage(copie);
    if (page.ajouts.length) await appliquerAjouts(docFinal, copie, page.ajouts, ressources);
  }
  return docFinal.save();
}

async function exporter(pagesAExporter, nom) {
  if (pagesAExporter.length === 0) return;
  afficherMessage('Création du PDF…');
  try {
    const octets = await construirePdf(pagesAExporter);
    telecharger(octets, nettoyerNom(nom));
    afficherMessage(`PDF créé : ${pagesAExporter.length} page(s).`);
  } catch (erreur) {
    console.error(erreur);
    afficherMessage('Impossible de créer le PDF : ' + erreur.message, true);
  }
}

// Retire les caractères interdits dans un nom de fichier Windows
function nettoyerNom(nom) {
  const propre = nom.trim().replace(/\.pdf$/i, '').replace(/[\\/:*?"<>|]/g, '_');
  return (propre || 'document') + '.pdf';
}

function telecharger(octets, nomFichier) {
  const blob = new Blob([octets], { type: 'application/pdf' });
  const lien = document.createElement('a');
  lien.href = URL.createObjectURL(blob);
  lien.download = nomFichier;
  lien.click();
  setTimeout(() => URL.revokeObjectURL(lien.href), 10000);
}
