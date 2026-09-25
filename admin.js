/* ============================================================
   ADMIN KATALOG — logika halaman admin
   Struktur file (cari komentar ini untuk lompat ke bagiannya):
   1. Shortcut & util kecil
   2. Panggilan ke GitHub API
   3. State (produk, banner, token)
   4. Login / cek izin token
   5. Simpan produk (create/update/delete)
   6. Render tabel produk
   7. Form tambah/edit produk
   8. Banner promosi (render, form, simpan, hapus)
   9. Init
   ============================================================ */

const C = CFG;
const $ = s => document.querySelector(s);

/* ---------- 1. Shortcut & util kecil ---------- */
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const rupiah = n => 'Rp' + Number(n || 0).toLocaleString('id-ID');

function toast(msg, isError) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = isError ? 'err' : '';
  t.style.display = 'block';
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.style.display = 'none'), Math.max(3500, msg.length * 70));
}

/* Kompres gambar ke JPG max 1200px sebelum diunggah, kembalikan base64 tanpa prefix data-uri */
function shrinkImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const ratio = Math.min(1, 1200 / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = img.width * ratio;
      canvas.height = img.height * ratio;
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL('image/jpeg', 0.82).split(',')[1]);
    };
    img.onerror = () => reject(new Error('File gambar tidak bisa dibaca'));
    img.src = URL.createObjectURL(file);
  });
}

/* ---------- 2. Panggilan ke GitHub API ---------- */
const PERM_MSG = 'Token belum bisa menulis ke repo ini. Di GitHub, edit token: (1) Repository access, pilih repo ini; (2) Repository permissions, klik Add permissions, pilih Contents, ubah ke Read and write; lalu klik Update. Setelah itu tempel token lagi di sini.';

function ghEncode(str) {
  let bin = '';
  for (const byte of new TextEncoder().encode(str)) bin += String.fromCharCode(byte);
  return btoa(bin);
}
function ghDecode(b64) {
  return new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\n/g, '')), c => c.charCodeAt(0)));
}
function gh(path, opts = {}) {
  const url = `https://api.github.com/repos/${C.owner}/${C.repo}${path ? '/' + path : ''}`;
  return fetch(url, { ...opts, headers: { Authorization: 'Bearer ' + state.token, Accept: 'application/vnd.github+json' } });
}
async function ghGetFile(path) {
  const r = await gh(`contents/${path}?ref=${C.branch}`);
  if (r.status === 404) return { sha: null, json: null };
  if (!r.ok) throw new Error((await r.json()).message);
  const j = await r.json();
  return { sha: j.sha, json: JSON.parse(ghDecode(j.content)) };
}
async function ghPutFile(path, base64Content, message, sha) {
  const r = await gh(`contents/${path}`, {
    method: 'PUT',
    body: JSON.stringify({ message, content: base64Content, branch: C.branch, ...(sha && { sha }) }),
  });
  if (!r.ok) {
    const m = (await r.json()).message || 'Gagal menyimpan';
    throw new Error(r.status === 403 || /not accessible/i.test(m) ? PERM_MSG : m);
  }
}
async function ghDeleteFile(path, message) {
  try {
    const j = await (await gh(`contents/${path}?ref=${C.branch}`)).json();
    await gh(`contents/${path}`, { method: 'DELETE', body: JSON.stringify({ message, sha: j.sha, branch: C.branch }) });
  } catch { /* gambar mungkin sudah tidak ada, aman diabaikan */ }
}
/* Uji izin tulis tanpa membuat commit/file sungguhan */
async function ghCanWrite() {
  try {
    const r = await gh('git/blobs', { method: 'POST', body: JSON.stringify({ content: 'cek', encoding: 'utf-8' }) });
    return r.ok ? '' : `${r.status}: ${(await r.json()).message || ''}`;
  } catch {
    return 'koneksi gagal';
  }
}
/* Baca+ubah sebuah file JSON ({key:[...]}) lalu commit balik dalam satu langkah */
async function mutateJsonFile(path, defaultData, mutateFn, commitMessage) {
  const { sha, json } = await ghGetFile(path);
  const data = json || defaultData;
  mutateFn(data);
  await ghPutFile(path, ghEncode(JSON.stringify(data, null, 2)), commitMessage, sha);
  return data;
}

/* ---------- 3. State ---------- */
const state = { token: localStorage.getItem('gh_tok') || '', products: [], banners: [], editingId: null, editingBannerId: null };

async function mutateProducts(mutateFn, commitMessage) {
  const data = await mutateJsonFile(C.dataPath, { products: [] }, mutateFn, commitMessage);
  state.products = data.products;
  renderTable();
}
async function mutateBanners(mutateFn, commitMessage) {
  const data = await mutateJsonFile(C.bannerDataPath, { banners: [] }, mutateFn, commitMessage);
  state.banners = data.banners;
  renderBannerTable();
}

/* ---------- 4. Login / cek izin token ---------- */
async function login() {
  const errEl = $('#lerr');
  errEl.textContent = '';

  if (C.owner.startsWith('USERNAME') || C.repo.startsWith('NAMA')) {
    errEl.textContent = 'config.js belum diisi. Ganti owner dan repo dengan milik Anda.';
    return false;
  }
  if (!state.token) {
    errEl.textContent = 'Tempel token terlebih dulu.';
    return false;
  }

  let res;
  try { res = await gh(''); }
  catch { errEl.textContent = 'Tidak bisa terhubung ke GitHub. Periksa koneksi internet Anda.'; return false; }

  if (!res.ok) {
    errEl.textContent = res.status === 401 ? 'Token tidak valid atau sudah kedaluwarsa.'
      : res.status === 404 ? 'Repo tidak ditemukan, atau token belum diberi akses ke repo ini. Periksa owner dan repo di config.js.'
      : `Gagal masuk (kode ${res.status}).`;
    return false;
  }

  const writeErr = await ghCanWrite();
  if (writeErr) {
    localStorage.removeItem('gh_tok');
    errEl.textContent = `${PERM_MSG} (Detail: ${writeErr})`;
    return false;
  }

  $('#login').hidden = true;
  $('#app').hidden = false;
  try { state.products = (await ghGetFile(C.dataPath)).json?.products || []; }
  catch (e) { toast(e.message, true); }
  try { state.banners = (await ghGetFile(C.bannerDataPath)).json?.banners || []; }
  catch (e) { toast(e.message, true); }
  renderTable();
  renderBannerTable();
  return true;
}

/* ---------- 5. Simpan produk (create/update/delete) ---------- */
async function saveProduct(item, oldImage) {
  await mutateProducts(data => {
    const i = data.products.findIndex(x => x.id == item.id);
    i < 0 ? data.products.unshift(item) : (data.products[i] = item);
  }, `${state.editingId ? 'Ubah' : 'Tambah'} produk: ${item.name}`);
  if (oldImage && oldImage !== item.image) await ghDeleteFile(oldImage, 'Hapus gambar lama');
}
async function deleteProduct(product) {
  await mutateProducts(data => {
    data.products = data.products.filter(x => x.id != product.id);
  }, 'Hapus produk: ' + product.name);
  if (product.image) await ghDeleteFile(product.image, 'Hapus gambar');
}

/* ---------- 6. Render tabel produk ---------- */
function promoLabelFor(p) {
  if (p.bxgy?.buy && p.bxgy?.free) return `Beli ${p.bxgy.buy} Gratis ${p.bxgy.free}`;
  return p.promo || '';
}
function renderTable() {
  const list = state.products;
  $('#cnt').textContent = `(${list.length})`;
  $('#empty').hidden = list.length > 0;
  $('#cl').innerHTML = [...new Set(list.map(p => p.category).filter(Boolean))]
    .map(c => `<option value="${esc(c)}">`).join('');

  $('#tbody').innerHTML = list.map(p => {
    const habis = (p.stock ?? 0) <= 0;
    const promo = promoLabelFor(p);
    return `
    <tr>
      <td class="thumb">${p.image ? `<img src="${esc(p.image)}" alt="">` : '<span class="ph"></span>'}</td>
      <td class="name"><b>${esc(p.name)}</b><span>${esc(p.category || 'Tanpa kategori')}</span></td>
      <td>${p.originalPrice > p.price ? `<span class="strike">${rupiah(p.originalPrice)}</span><br>` : ''}${rupiah(p.price)}</td>
      <td>${p.stock ?? 0}</td>
      <td>${promo ? esc(promo) : '<span class="mut">—</span>'}</td>
      <td><span class="${habis ? 'status-out' : 'status-ok'}">${habis ? 'habis' : 'tersedia'}</span></td>
      <td class="actions">
        <button type="button" class="btn ghost sm" data-edit="${esc(p.id)}">Edit</button>
        <button type="button" class="btn bad sm" data-del="${esc(p.id)}">Hapus</button>
      </td>
    </tr>`;
  }).join('');
}

/* ---------- 7. Form tambah/edit produk ---------- */
function resetForm() {
  state.editingId = null;
  $('#f').reset();
  $('#ft').textContent = 'Tambah produk';
  $('#pv').hidden = true;
}
function openFormDialog() {
  $('#formDl').showModal();
}
function fillFormForEdit(product) {
  state.editingId = product.id;
  $('#ft').textContent = 'Edit produk';
  $('#n').value = product.name;
  $('#c').value = product.category || '';
  $('#p').value = product.price;
  $('#op').value = product.originalPrice || '';
  $('#stk').value = product.stock ?? 0;
  $('#promo').value = product.promo || '';
  $('#bxgy_buy').value = product.bxgy?.buy || '';
  $('#bxgy_free').value = product.bxgy?.free || '';
  $('#d').value = product.desc || '';
  $('#pv').hidden = true;
  openFormDialog();
}

$('#i').addEventListener('change', e => {
  const file = e.target.files[0];
  $('#pv').hidden = !file;
  if (file) $('#pv').src = URL.createObjectURL(file);
});

$('#tbody').addEventListener('click', async e => {
  const btn = e.target.closest('button');
  if (!btn) return;

  if (btn.dataset.edit) {
    fillFormForEdit(state.products.find(p => p.id == btn.dataset.edit));
  }

  if (btn.dataset.del) {
    const product = state.products.find(p => p.id == btn.dataset.del);
    if (!confirm(`Hapus "${product.name}" beserta gambarnya?`)) return;
    btn.disabled = true;
    try { await deleteProduct(product); toast('Produk dihapus'); }
    catch (err) { toast(err.message, true); btn.disabled = false; }
  }
});

$('#f').addEventListener('submit', async e => {
  e.preventDefault();
  const saveBtn = $('#sv');
  saveBtn.disabled = true;
  saveBtn.textContent = 'Menyimpan…';

  try {
    const file = $('#i').files[0];
    const editing = state.editingId ? state.products.find(p => p.id == state.editingId) : null;
    let image = editing?.image || '';
    if (file) {
      image = `${C.imageDir}/${Date.now()}.jpg`;
      await ghPutFile(image, await shrinkImage(file), 'Upload gambar produk');
    }
    const buy = +$('#bxgy_buy').value || 0, free = +$('#bxgy_free').value || 0;
    const item = {
      id: state.editingId || Date.now().toString(36),
      name: $('#n').value.trim(),
      category: $('#c').value.trim(),
      price: +$('#p').value,
      originalPrice: +$('#op').value || 0,
      stock: +$('#stk').value || 0,
      promo: $('#promo').value.trim(),
      bxgy: (buy && free) ? { buy, free } : null,
      status: (+$('#stk').value || 0) <= 0 ? 'habis' : 'tersedia',
      desc: $('#d').value.trim(),
      image,
      updated: new Date().toISOString(),
    };
    await saveProduct(item, editing?.image);
    resetForm();
    $('#formDl').close();
    toast('Produk tersimpan');
  } catch (err) {
    toast(err.message, true);
  }
  saveBtn.disabled = false;
  saveBtn.textContent = 'Simpan produk';
});

$('#cx').addEventListener('click', () => $('#formDl').close());
$('#fclose').addEventListener('click', () => $('#formDl').close());
$('#formDl').addEventListener('click', e => { if (e.target.id === 'formDl') e.target.close(); });
$('#addBtn').addEventListener('click', () => { resetForm(); openFormDialog(); });

/* ---------- 8. Banner promosi ---------- */
function renderBannerTable() {
  const list = state.banners;
  $('#bcnt').textContent = `(${list.length})`;
  $('#bempty').hidden = list.length > 0;
  $('#btbody').innerHTML = list.map(b => {
    const names = (b.productIds || []).map(id => state.products.find(p => p.id == id)?.name).filter(Boolean);
    return `
    <tr>
      <td class="thumb">${b.image ? `<img src="${esc(b.image)}" alt="">` : '<span class="ph"></span>'}</td>
      <td>${names.length ? esc(names.join(', ')) : '<span class="mut">Tidak ada produk terkait</span>'}</td>
      <td class="actions">
        <button type="button" class="btn ghost sm" data-bedit="${esc(b.id)}">Edit</button>
        <button type="button" class="btn bad sm" data-bdel="${esc(b.id)}">Hapus</button>
      </td>
    </tr>`;
  }).join('');
}
function renderProductCheckboxes(selectedIds) {
  const sel = new Set(selectedIds || []);
  $('#b_products').innerHTML = state.products.length
    ? state.products.map(p => `
      <label class="check-item">
        <input type="checkbox" value="${esc(p.id)}" ${sel.has(p.id) ? 'checked' : ''}>
        <span>${esc(p.name)}</span>
      </label>`).join('')
    : '<p class="mut">Belum ada produk. Tambahkan produk dulu sebelum membuat banner.</p>';
}
function resetBannerForm() {
  state.editingBannerId = null;
  $('#bf').reset();
  $('#bft').textContent = 'Tambah banner';
  $('#b_pv').hidden = true;
  renderProductCheckboxes([]);
}
function fillBannerForEdit(banner) {
  state.editingBannerId = banner.id;
  $('#bft').textContent = 'Edit banner';
  $('#b_pv').hidden = true;
  renderProductCheckboxes(banner.productIds);
  $('#bannerDl').showModal();
}
$('#b_img').addEventListener('change', e => {
  const file = e.target.files[0];
  $('#b_pv').hidden = !file;
  if (file) $('#b_pv').src = URL.createObjectURL(file);
});
$('#addBannerBtn').addEventListener('click', () => { resetBannerForm(); $('#bannerDl').showModal(); });
$('#b_cx').addEventListener('click', () => $('#bannerDl').close());
$('#bclose').addEventListener('click', () => $('#bannerDl').close());
$('#bannerDl').addEventListener('click', e => { if (e.target.id === 'bannerDl') e.target.close(); });

$('#btbody').addEventListener('click', async e => {
  const btn = e.target.closest('button');
  if (!btn) return;
  if (btn.dataset.bedit) fillBannerForEdit(state.banners.find(b => b.id == btn.dataset.bedit));
  if (btn.dataset.bdel) {
    const banner = state.banners.find(b => b.id == btn.dataset.bdel);
    if (!confirm('Hapus banner ini?')) return;
    btn.disabled = true;
    try {
      await mutateBanners(data => { data.banners = data.banners.filter(x => x.id != banner.id); }, 'Hapus banner');
      if (banner.image) await ghDeleteFile(banner.image, 'Hapus gambar banner');
      toast('Banner dihapus');
    } catch (err) { toast(err.message, true); btn.disabled = false; }
  }
});

$('#bf').addEventListener('submit', async e => {
  e.preventDefault();
  const saveBtn = $('#b_sv');
  const productIds = [...document.querySelectorAll('#b_products input:checked')].map(i => i.value);
  const editing = state.editingBannerId ? state.banners.find(b => b.id == state.editingBannerId) : null;
  const file = $('#b_img').files[0];

  if (!file && !editing?.image) { toast('Pilih gambar banner terlebih dulu.', true); return; }
  if (!productIds.length) { toast('Pilih minimal satu produk terkait.', true); return; }

  saveBtn.disabled = true;
  saveBtn.textContent = 'Menyimpan…';
  try {
    let image = editing?.image || '';
    if (file) {
      image = `${C.bannerImageDir}/${Date.now()}.jpg`;
      await ghPutFile(image, await shrinkImage(file), 'Upload gambar banner');
    }
    const item = { id: state.editingBannerId || Date.now().toString(36), image, productIds, updated: new Date().toISOString() };
    await mutateBanners(data => {
      const i = data.banners.findIndex(x => x.id == item.id);
      i < 0 ? data.banners.push(item) : (data.banners[i] = item);
    }, `${editing ? 'Ubah' : 'Tambah'} banner`);
    if (editing?.image && editing.image !== image) await ghDeleteFile(editing.image, 'Hapus gambar banner lama');
    resetBannerForm();
    $('#bannerDl').close();
    toast('Banner tersimpan');
  } catch (err) {
    toast(err.message, true);
  }
  saveBtn.disabled = false;
  saveBtn.textContent = 'Simpan banner';
});

/* ---------- 9. Init ---------- */
$('#go').addEventListener('click', async () => {
  const btn = $('#go');
  state.token = $('#tok').value.trim();
  btn.disabled = true; btn.textContent = 'Memeriksa…';
  try { if (await login()) localStorage.setItem('gh_tok', state.token); }
  catch (e) { $('#lerr').textContent = 'Terjadi kesalahan: ' + e.message; }
  btn.disabled = false; btn.textContent = 'Masuk';
});
$('#tok').addEventListener('keydown', e => { if (e.key === 'Enter') $('#go').click(); });
$('#out').addEventListener('click', () => { localStorage.removeItem('gh_tok'); location.reload(); });

if (state.token) login();
