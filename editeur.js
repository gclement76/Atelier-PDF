// =====================================================================
// Éditeur de page : ajouter du texte, des rectangles (pour masquer),
// des images et une signature par-dessus une page.
// =====================================================================

const { rgb, StandardFonts, pushGraphicsState, popGraphicsState, concatTransformationMatrix } = PDFLib;

// ---------------------------------------------------------------------
// Repères et rotations
// ---------------------------------------------------------------------
// Chaque ajout est positionné en points (1 pt = 1/72 de pouce), origine en
// haut à gauche, dans le « repère d'affichage » de la page au moment où il a
// été créé (rotationRepere = 0, 90, 180 ou 270). Ainsi, si on pivote la page
// ensuite, l'ajout tourne avec elle.
//
// Une matrice [a, b, c, d, e, f] transforme un point (x, y) en :
//   x' = a*x + c*y + e    et    y' = b*x + d*y + f

// Applique d'abord m2, puis m1
function multiplier(m1, m2) {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

function inverser(m) {
  const det = m[0] * m[3] - m[1] * m[2];
  const a = m[3] / det, b = -m[1] / det, c = -m[2] / det, d = m[0] / det;
  return [a, b, c, d, -(a * m[4] + c * m[5]), -(b * m[4] + d * m[5])];
}

// Repère d'affichage (pivoté de R, y vers le bas) → repère PDF de la page
// non pivotée (y vers le haut). w et h : largeur et hauteur de la page non pivotée.
function versPage(R, w, h) {
  switch (R) {
    case 90: return [0, 1, 1, 0, 0, 0];
    case 180: return [-1, 0, 0, 1, w, 0];
    case 270: return [0, -1, -1, 0, w, h];
    default: return [1, 0, 0, -1, 0, h];
  }
}

// Repère d'un ajout → repère d'affichage actuel de la page (pivoté de R)
function matriceAffichage(ajout, R, w, h) {
  return multiplier(inverser(versPage(R, w, h)), versPage(ajout.rotationRepere, w, h));
}

// Largeur et hauteur de la page non pivotée, d'après pdf.js
function dimensions(pagePdfjs) {
  const [x0, y0, x1, y1] = pagePdfjs.view;
  return { w: x1 - x0, h: y1 - y0 };
}

// Position de la ligne de base du texte sous le haut de la boîte
// (correspond à l'affichage avec la police Arial et un interligne de 1,2)
const BASE_TEXTE = 0.946;
const INTERLIGNE = 1.2;

// ---------------------------------------------------------------------
// Dessin des ajouts sur une miniature (canvas)
// ---------------------------------------------------------------------
function dessinerAjouts(contexte, ajouts, echelle, R, w, h) {
  for (const ajout of ajouts) {
    const m = matriceAffichage(ajout, R, w, h).map((v) => v * echelle);
    contexte.save();
    contexte.setTransform(...m);
    if (ajout.type === 'rectangle') {
      contexte.fillStyle = ajout.couleur;
      contexte.fillRect(ajout.x, ajout.y, ajout.largeur, ajout.hauteur);
    } else if (ajout.type === 'image') {
      contexte.drawImage(ajout.imageChargee, ajout.x, ajout.y, ajout.largeur, ajout.hauteur);
    } else if (ajout.type === 'texte') {
      contexte.fillStyle = ajout.couleur;
      contexte.font = `${ajout.gras ? 'bold ' : ''}${ajout.taille}px Arial, Helvetica, sans-serif`;
      ajout.texte.split('\n').forEach((ligne, i) => {
        contexte.fillText(ligne, ajout.x, ajout.y + ajout.taille * (BASE_TEXTE + i * INTERLIGNE));
      });
    }
    contexte.restore();
  }
}

// ---------------------------------------------------------------------
// Écriture des ajouts dans le PDF final (pdf-lib)
// ---------------------------------------------------------------------
function couleurRgb(hexa) {
  const n = parseInt(hexa.slice(1), 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

// Les polices de base du PDF ne connaissent pas tous les caractères
// (emojis, etc.) : on remplace les caractères impossibles par « ? »
function nettoyerTexte(texte, police) {
  return [...texte].map((caractere) => {
    if (caractere === '\n') return caractere;
    try {
      police.encodeText(caractere);
      return caractere;
    } catch {
      return '?';
    }
  }).join('');
}

// ressources : polices et images déjà intégrées au document (pour ne pas les dupliquer)
async function appliquerAjouts(docFinal, pagePdf, ajouts, ressources) {
  const { x: x0, y: y0, width: w, height: h } = pagePdf.getCropBox();
  for (const ajout of ajouts) {
    const R = ajout.rotationRepere;
    const hauteurAffichee = R % 180 === 0 ? h : w;
    // Repère de l'ajout avec y vers le haut (celui qu'attend pdf-lib) → page
    const m = multiplier(versPage(R, w, h), [1, 0, 0, -1, 0, hauteurAffichee]);
    pagePdf.pushOperators(pushGraphicsState(), concatTransformationMatrix(m[0], m[1], m[2], m[3], m[4] + x0, m[5] + y0));

    const basDeLaBoite = hauteurAffichee - ajout.y - ajout.hauteur;
    if (ajout.type === 'rectangle') {
      pagePdf.drawRectangle({
        x: ajout.x, y: basDeLaBoite, width: ajout.largeur, height: ajout.hauteur,
        color: couleurRgb(ajout.couleur),
      });
    } else if (ajout.type === 'image') {
      if (!ressources.images.has(ajout.octets)) {
        const image = ajout.typeImage === 'image/jpeg'
          ? await docFinal.embedJpg(ajout.octets)
          : await docFinal.embedPng(ajout.octets);
        ressources.images.set(ajout.octets, image);
      }
      pagePdf.drawImage(ressources.images.get(ajout.octets), {
        x: ajout.x, y: basDeLaBoite, width: ajout.largeur, height: ajout.hauteur,
      });
    } else if (ajout.type === 'texte' && ajout.texte.trim()) {
      const nomPolice = ajout.gras ? StandardFonts.HelveticaBold : StandardFonts.Helvetica;
      if (!ressources.polices[nomPolice]) ressources.polices[nomPolice] = await docFinal.embedFont(nomPolice);
      const police = ressources.polices[nomPolice];
      pagePdf.drawText(nettoyerTexte(ajout.texte, police), {
        x: ajout.x,
        y: hauteurAffichee - ajout.y - ajout.taille * BASE_TEXTE,
        size: ajout.taille,
        lineHeight: ajout.taille * INTERLIGNE,
        font: police,
        color: couleurRgb(ajout.couleur),
      });
    }
    pagePdf.pushOperators(popGraphicsState());
  }
}

// =====================================================================
// Fenêtre d'édition
// =====================================================================
const elEditeur = document.getElementById('editeur');
const zoneFeuille = document.getElementById('zoneFeuille');
const feuille = document.getElementById('feuille');
const canvasFeuille = document.getElementById('canvasFeuille');
const calque = document.getElementById('calque');
const panneauProprietes = document.getElementById('proprietes');
const propTexte = document.getElementById('propTexte');
const propTaille = document.getElementById('propTaille');
const propGras = document.getElementById('propGras');
const propCouleur = document.getElementById('propCouleur');
const champImage = document.getElementById('champImage');

// État de l'édition en cours
const edition = {
  page: null,      // page du tableau « pages » en cours de modification
  ajouts: [],      // copie de travail des ajouts (appliquée seulement si on valide)
  selection: null, // ajout sélectionné
  echelle: 1,      // pixels à l'écran par point PDF
  R: 0, w: 0, h: 0,
  tacheDessin: null,
};
let glissement = null; // déplacement ou redimensionnement en cours à la souris

async function ouvrirEditeur(page) {
  edition.page = page;
  edition.ajouts = page.ajouts.map((a) => ({ ...a }));
  edition.selection = null;
  document.getElementById('editeurNumero').textContent = pages.indexOf(page) + 1;
  elEditeur.hidden = false;
  document.body.classList.add('sans-defilement');
  await dessinerFeuille();
  afficherProprietes();
}

function fermerEditeur() {
  elEditeur.hidden = true;
  document.body.classList.remove('sans-defilement');
  fermerSignature();
  edition.page = null;
}

// Affiche la page en grand, à la taille de la zone disponible
async function dessinerFeuille() {
  const page = edition.page;
  const pagePdfjs = await fichiers.get(page.idFichier).docPdfjs.getPage(page.numero + 1);
  Object.assign(edition, dimensions(pagePdfjs));
  edition.R = (pagePdfjs.rotate + page.rotation) % 360;

  const vueTaille1 = pagePdfjs.getViewport({ scale: 1, rotation: edition.R });
  const zone = zoneFeuille.getBoundingClientRect();
  edition.echelle = Math.min((zone.width - 48) / vueTaille1.width, (zone.height - 48) / vueTaille1.height);
  const largeur = vueTaille1.width * edition.echelle;
  const hauteur = vueTaille1.height * edition.echelle;
  feuille.style.width = largeur + 'px';
  feuille.style.height = hauteur + 'px';
  afficherAjouts();

  // Rendu net sur les écrans haute résolution
  const densite = window.devicePixelRatio || 1;
  const vue = pagePdfjs.getViewport({ scale: edition.echelle * densite, rotation: edition.R });
  canvasFeuille.width = Math.round(vue.width);
  canvasFeuille.height = Math.round(vue.height);
  edition.tacheDessin?.cancel();
  edition.tacheDessin = pagePdfjs.render({ canvasContext: canvasFeuille.getContext('2d'), viewport: vue });
  try {
    await edition.tacheDessin.promise;
  } catch (erreur) {
    if (erreur.name !== 'RenderingCancelledException') console.error(erreur);
  }
}

// ----- Éléments posés sur la page -----
function afficherAjouts() {
  calque.innerHTML = '';
  for (const ajout of edition.ajouts) {
    const element = document.createElement('div');
    element.className = `ajout ajout-${ajout.type}`;
    element.dataset.id = ajout.id;
    if (ajout.type === 'image') {
      const image = document.createElement('img');
      image.src = ajout.url;
      image.draggable = false;
      element.appendChild(image);
    }
    if (ajout.type !== 'texte') {
      const poignee = document.createElement('span');
      poignee.className = 'poignee';
      poignee.title = 'Redimensionner';
      element.appendChild(poignee);
    }
    calque.appendChild(element);
    mettreAJourElement(element, ajout);
  }
}

function elementDe(ajout) {
  return calque.querySelector(`[data-id="${ajout.id}"]`);
}

// Place l'élément à l'écran selon la position de l'ajout
function mettreAJourElement(element, ajout) {
  const s = edition.echelle;
  const m = matriceAffichage(ajout, edition.R, edition.w, edition.h);
  element.style.transform =
    `matrix(${m[0]}, ${m[1]}, ${m[2]}, ${m[3]}, ${m[4] * s}, ${m[5] * s}) translate(${ajout.x * s}px, ${ajout.y * s}px)`;
  element.classList.toggle('selectionne', ajout === edition.selection);
  if (ajout.type === 'texte') {
    element.textContent = ajout.texte || ' ';
    element.style.fontSize = ajout.taille * s + 'px';
    element.style.color = ajout.couleur;
    element.style.fontWeight = ajout.gras ? 'bold' : 'normal';
  } else {
    element.style.width = ajout.largeur * s + 'px';
    element.style.height = ajout.hauteur * s + 'px';
    if (ajout.type === 'rectangle') element.style.background = ajout.couleur;
  }
}

function selectionner(ajout) {
  edition.selection = ajout;
  calque.querySelectorAll('.ajout').forEach((el) => el.classList.toggle('selectionne', ajout && el.dataset.id == ajout.id));
  afficherProprietes();
}

// ----- Panneau des propriétés de l'élément sélectionné -----
function afficherProprietes() {
  const ajout = edition.selection;
  panneauProprietes.hidden = !ajout;
  if (!ajout) return;
  const titres = { texte: 'Texte', rectangle: 'Rectangle', image: 'Image' };
  document.getElementById('proprietesTitre').textContent = titres[ajout.type];
  document.getElementById('propsTexte').hidden = ajout.type !== 'texte';
  document.getElementById('propsCouleur').hidden = ajout.type === 'image';
  document.getElementById('infoRectangle').hidden = ajout.type !== 'rectangle';
  if (ajout.type === 'texte') {
    propTexte.value = ajout.texte;
    propTaille.value = ajout.taille;
    propGras.checked = ajout.gras;
  }
  if (ajout.couleur) propCouleur.value = ajout.couleur;
}

function modifierSelection(changement) {
  const ajout = edition.selection;
  if (!ajout) return;
  Object.assign(ajout, changement);
  mettreAJourElement(elementDe(ajout), ajout);
}

propTexte.addEventListener('input', () => modifierSelection({ texte: propTexte.value }));
propTaille.addEventListener('input', () => {
  const taille = Number(propTaille.value);
  if (taille >= 4 && taille <= 300) modifierSelection({ taille });
});
propGras.addEventListener('change', () => modifierSelection({ gras: propGras.checked }));
propCouleur.addEventListener('input', () => modifierSelection({ couleur: propCouleur.value }));

function supprimerSelection() {
  if (!edition.selection) return;
  edition.ajouts = edition.ajouts.filter((a) => a !== edition.selection);
  edition.selection = null;
  afficherAjouts();
  afficherProprietes();
}
document.getElementById('btnSupprimerAjout').addEventListener('click', supprimerSelection);

// ----- Ajout d'éléments -----
// Largeur et hauteur de la page telle qu'elle est affichée
function tailleAffichee() {
  return edition.R % 180 === 0 ? { W: edition.w, H: edition.h } : { W: edition.h, H: edition.w };
}

function ajouterElement(ajout, largeur, hauteur) {
  const { W, H } = tailleAffichee();
  ajout.id = ++compteurId;
  ajout.rotationRepere = edition.R;
  // Placé au centre de la page
  ajout.x = (W - largeur) / 2;
  ajout.y = (H - hauteur) / 2;
  edition.ajouts.push(ajout);
  afficherAjouts();
  selectionner(ajout);
}

document.getElementById('btnAjoutTexte').addEventListener('click', () => {
  ajouterElement({ type: 'texte', texte: 'Votre texte', taille: 14, couleur: '#000000', gras: false }, 80, 17);
  propTexte.focus();
  propTexte.select();
});

document.getElementById('btnAjoutRectangle').addEventListener('click', () => {
  ajouterElement({ type: 'rectangle', largeur: 150, hauteur: 40, couleur: '#ffffff' }, 150, 40);
});

document.getElementById('btnAjoutImage').addEventListener('click', () => champImage.click());

champImage.addEventListener('change', async () => {
  const fichier = champImage.files[0];
  champImage.value = '';
  if (!fichier) return;
  try {
    ajouterImage(await preparerImage(fichier), 200);
  } catch (erreur) {
    console.error(erreur);
    alert(`Impossible de lire l'image « ${fichier.name} ».`);
  }
});

// Ajoute une image (ou une signature) avec une largeur de départ en points
function ajouterImage(donneesImage, largeurVoulue) {
  const largeur = Math.min(largeurVoulue, tailleAffichee().W * 0.6);
  const hauteur = largeur * donneesImage.ratio;
  ajouterElement({ type: 'image', largeur, hauteur, ...donneesImage }, largeur, hauteur);
}

// Le PDF accepte directement le PNG et le JPEG ; les autres formats sont convertis en PNG
async function preparerImage(blob) {
  let typeImage = blob.type;
  if (typeImage !== 'image/png' && typeImage !== 'image/jpeg') {
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext('2d').drawImage(bitmap, 0, 0);
    blob = await new Promise((resoudre) => canvas.toBlob(resoudre, 'image/png'));
    typeImage = 'image/png';
  }
  const url = URL.createObjectURL(blob);
  const imageChargee = new Image();
  imageChargee.src = url;
  await imageChargee.decode();
  return {
    octets: new Uint8Array(await blob.arrayBuffer()),
    typeImage,
    url,
    imageChargee,
    ratio: imageChargee.naturalHeight / imageChargee.naturalWidth,
  };
}

// ----- Déplacer / redimensionner à la souris -----
calque.addEventListener('pointerdown', (evenement) => {
  const element = evenement.target.closest('.ajout');
  if (!element) return;
  evenement.preventDefault();
  evenement.stopPropagation();
  const ajout = edition.ajouts.find((a) => a.id == element.dataset.id);
  selectionner(ajout);
  glissement = {
    ajout,
    element,
    departX: evenement.clientX,
    departY: evenement.clientY,
    origine: { x: ajout.x, y: ajout.y, largeur: ajout.largeur, hauteur: ajout.hauteur },
    redimension: evenement.target.classList.contains('poignee'),
  };
  element.setPointerCapture(evenement.pointerId);
});

calque.addEventListener('pointermove', (evenement) => {
  if (!glissement) return;
  const { ajout, origine } = glissement;
  // Déplacement de la souris, converti en points dans le repère de l'ajout
  const s = edition.echelle;
  const dx = (evenement.clientX - glissement.departX) / s;
  const dy = (evenement.clientY - glissement.departY) / s;
  const inv = inverser(matriceAffichage(ajout, edition.R, edition.w, edition.h));
  const lx = inv[0] * dx + inv[2] * dy;
  const ly = inv[1] * dx + inv[3] * dy;
  if (glissement.redimension) {
    ajout.largeur = Math.max(5, origine.largeur + lx);
    // Les images gardent leurs proportions
    ajout.hauteur = ajout.type === 'image' ? ajout.largeur * ajout.ratio : Math.max(3, origine.hauteur + ly);
  } else {
    ajout.x = origine.x + lx;
    ajout.y = origine.y + ly;
  }
  mettreAJourElement(glissement.element, ajout);
});

calque.addEventListener('pointerup', () => (glissement = null));
calque.addEventListener('pointercancel', () => (glissement = null));

// Clic à côté d'un élément : désélectionne
zoneFeuille.addEventListener('pointerdown', (evenement) => {
  if (!evenement.target.closest('.ajout')) selectionner(null);
});

// Double-clic sur un texte : place le curseur dans la zone de saisie
calque.addEventListener('dblclick', (evenement) => {
  if (evenement.target.closest('.ajout-texte')) propTexte.focus();
});

// ----- Valider / annuler -----
document.getElementById('btnValiderEdition').addEventListener('click', () => {
  const page = edition.page;
  page.ajouts = edition.ajouts;
  fermerEditeur();
  dessinerVignette(page, cartes.get(page.id).querySelector('canvas'));
  afficherMessage(`Page ${pages.indexOf(page) + 1} modifiée (${page.ajouts.length} élément(s) ajouté(s)).`);
});

document.getElementById('btnAnnulerEdition').addEventListener('click', fermerEditeur);

// Clavier : Suppr pour supprimer l'élément, Échap pour fermer
document.addEventListener('keydown', (evenement) => {
  if (elEditeur.hidden) return;
  const dansUnChamp = evenement.target.matches('input, textarea');
  if (evenement.key === 'Escape') {
    if (!fenetreSignature.hidden) fermerSignature();
    else fermerEditeur();
  } else if ((evenement.key === 'Delete' || evenement.key === 'Backspace') && !dansUnChamp) {
    evenement.preventDefault();
    supprimerSelection();
  }
});

// Si la fenêtre change de taille, on redessine la page à la bonne taille
let minuterieRedimension;
window.addEventListener('resize', () => {
  if (elEditeur.hidden) return;
  clearTimeout(minuterieRedimension);
  minuterieRedimension = setTimeout(dessinerFeuille, 200);
});

// =====================================================================
// Signature dessinée à la souris
// =====================================================================
const fenetreSignature = document.getElementById('fenetreSignature');
const padSignature = document.getElementById('padSignature');
const contexteSignature = padSignature.getContext('2d');
let traitEnCours = false;
let signatureVide = true;

function ouvrirSignature() {
  // La fenêtre est affichée d'abord : la taille du pad n'est connue qu'ensuite
  fenetreSignature.hidden = false;
  const densite = window.devicePixelRatio || 1;
  padSignature.width = padSignature.clientWidth * densite; // vide aussi le pad
  padSignature.height = padSignature.clientHeight * densite;
  contexteSignature.setTransform(densite, 0, 0, densite, 0, 0);
  signatureVide = true;
}

function fermerSignature() {
  fenetreSignature.hidden = true;
}

function positionDansPad(evenement) {
  const rectangle = padSignature.getBoundingClientRect();
  return { x: evenement.clientX - rectangle.left, y: evenement.clientY - rectangle.top };
}

padSignature.addEventListener('pointerdown', (evenement) => {
  traitEnCours = true;
  signatureVide = false;
  padSignature.setPointerCapture(evenement.pointerId);
  const { x, y } = positionDansPad(evenement);
  contexteSignature.strokeStyle = document.querySelector('input[name="couleurSignature"]:checked').value;
  contexteSignature.lineWidth = 2.5;
  contexteSignature.lineCap = 'round';
  contexteSignature.lineJoin = 'round';
  contexteSignature.beginPath();
  contexteSignature.moveTo(x, y);
  contexteSignature.lineTo(x + 0.1, y); // un simple clic laisse un point
  contexteSignature.stroke();
});

padSignature.addEventListener('pointermove', (evenement) => {
  if (!traitEnCours) return;
  const { x, y } = positionDansPad(evenement);
  contexteSignature.lineTo(x, y);
  contexteSignature.stroke();
});

padSignature.addEventListener('pointerup', () => (traitEnCours = false));

document.getElementById('btnAjoutSignature').addEventListener('click', ouvrirSignature);
document.getElementById('btnEffacerSignature').addEventListener('click', () => {
  contexteSignature.clearRect(0, 0, padSignature.width, padSignature.height);
  signatureVide = true;
});
document.getElementById('btnAnnulerSignature').addEventListener('click', fermerSignature);

document.getElementById('btnInsererSignature').addEventListener('click', async () => {
  if (signatureVide) return fermerSignature();
  const recadree = recadrerSignature();
  fermerSignature();
  const blob = await new Promise((resoudre) => recadree.toBlob(resoudre, 'image/png'));
  ajouterImage(await preparerImage(blob), 150);
});

// Ne garde que la partie dessinée du pad (fond transparent)
function recadrerSignature() {
  const { width, height } = padSignature;
  const pixels = contexteSignature.getImageData(0, 0, width, height).data;
  let gauche = width, haut = height, droite = 0, bas = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (pixels[(y * width + x) * 4 + 3] > 0) {
        if (x < gauche) gauche = x;
        if (x > droite) droite = x;
        if (y < haut) haut = y;
        if (y > bas) bas = y;
      }
    }
  }
  const marge = 4;
  gauche = Math.max(0, gauche - marge);
  haut = Math.max(0, haut - marge);
  const largeur = Math.min(width, droite + marge) - gauche;
  const hauteur = Math.min(height, bas + marge) - haut;
  const canvas = document.createElement('canvas');
  canvas.width = largeur;
  canvas.height = hauteur;
  canvas.getContext('2d').drawImage(padSignature, gauche, haut, largeur, hauteur, 0, 0, largeur, hauteur);
  return canvas;
}
