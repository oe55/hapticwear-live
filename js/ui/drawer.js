/**
 * The music library panel. It slides over the dashboard's right-hand column, on the same grid.
 * Categories along the top, tracks below. My Library adds a drop zone for files and folders from
 * the show computer.
 */

import { MY_LIBRARY_ID, filesFromDrop } from '../audio/library.js';

const $ = (id) => document.getElementById(id);
const fmt = (s) => (s > 0 ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}` : '');

export class Drawer {
  /**
   * @param {Library} library
   * @param {object} on  { play(track), added(count) }
   */
  constructor(library, on) {
    this.library = library;
    this.on = on;
    this.el = $('drawer');
    this.catsEl = $('cats');
    this.listEl = $('tracks');
    this.blurbEl = $('cat-blurb');
    this.dropEl = $('drop');
    this.catId = null;
    this.current = null;
    this.isOpen = false;

    $('close-library').addEventListener('click', () => this.close());
    library.addEventListener('change', () => { if (this.catId === MY_LIBRARY_ID) this.render(); });

    // My Library: file and folder pickers, drag and drop.
    const fileInput = $('file-input'), folderInput = $('folder-input');
    $('pick-files').addEventListener('click', () => fileInput.click());
    $('pick-folder').addEventListener('click', () => folderInput.click());
    const fromInput = (input, byFolder) => async () => {
      const entries = [...input.files].map((file) => ({
        file, group: byFolder ? (file.webkitRelativePath || '').split('/').slice(-2, -1)[0] || '' : '',
      }));
      input.value = '';
      this._add(entries);
    };
    fileInput.addEventListener('change', fromInput(fileInput, false));
    folderInput.addEventListener('change', fromInput(folderInput, true));
    const drag = (on) => (e) => { e.preventDefault(); this.dropEl.classList.toggle('is-over', on); };
    this.el.addEventListener('dragover', drag(true));
    this.el.addEventListener('dragleave', drag(false));
    this.el.addEventListener('drop', async (e) => {
      drag(false)(e);
      if (this.catId !== MY_LIBRARY_ID) this.select(MY_LIBRARY_ID);
      this._add(await filesFromDrop(e.dataTransfer));
    });
  }

  async _add(entries) {
    if (!entries.length) return;
    const n = await this.library.addFiles(entries);
    this.on.added(n);
  }

  open(catId) {
    this.select(catId || this.catId || (this.current && this.current.category) || this.library.categories[0].id);
    this.isOpen = true;
    this.el.setAttribute('aria-hidden', 'false');
    document.body.classList.add('is-drawer');
  }

  close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.el.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('is-drawer');
  }

  toggle() { this.isOpen ? this.close() : this.open(); }

  select(catId) {
    this.catId = catId;
    this.render();
  }

  setCurrent(track) {
    this.current = track;
    this.listEl.querySelectorAll('.track').forEach((li) => li.classList.toggle('is-current', !!track && li.dataset.id === track.id));
  }

  render() {
    const lib = this.library;
    this.catsEl.replaceChildren(...lib.categories.map((c) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'cat';
      b.role = 'tab';
      b.textContent = c.title;
      b.setAttribute('aria-selected', String(c.id === this.catId));
      b.addEventListener('click', () => this.select(c.id));
      return b;
    }));
    const cat = lib.category(this.catId);
    if (!cat) return;
    const mine = cat.id === MY_LIBRARY_ID;
    this.blurbEl.textContent = mine && cat.sessionOnly
      ? 'This window does not keep files, so they play until it closes. Use a normal window to keep them.'
      : cat.blurb;
    this.dropEl.hidden = !mine;

    const rows = [];
    let group = null;
    for (const t of cat.tracks) {
      if (mine && t.group !== group) {
        group = t.group;
        if (group) {
          const g = document.createElement('li');
          g.className = 'group';
          g.textContent = group;
          rows.push(g);
        }
      }
      rows.push(this._row(t, mine));
    }
    if (!cat.tracks.length) {
      const e = document.createElement('li');
      e.className = 'empty';
      e.textContent = mine
        ? 'Nothing here yet. Add DRM-free audio files (bought from iTunes, Bandcamp, Amazon…). Streaming-app downloads are locked and will not play.'
        : 'No tracks in this category.';
      rows.push(e);
    }
    this.listEl.replaceChildren(...rows);
    this.setCurrent(this.current);
  }

  _row(t, removable) {
    const li = document.createElement('li');
    li.className = 'track';
    li.dataset.id = t.id;
    li.tabIndex = 0;
    const title = document.createElement('div');
    title.className = 'track__title';
    title.textContent = t.title;
    const meta = document.createElement('div');
    meta.className = 'track__meta';
    meta.textContent = [t.artist, t.licence].filter(Boolean).join('  ·  ').toUpperCase() || (t.local ? 'LOCAL FILE' : '');
    const side = document.createElement('div');
    side.className = 'track__side';
    const eq = document.createElement('span');
    eq.className = 'eq';
    eq.append(document.createElement('i'), document.createElement('i'), document.createElement('i'));
    const dur = document.createElement('span');
    dur.textContent = fmt(t.duration);
    side.append(eq, dur);
    if (removable) {
      const x = document.createElement('button');
      x.type = 'button';
      x.className = 'track__remove';
      x.setAttribute('aria-label', `Remove ${t.title}`);
      x.append($('close-library').firstElementChild.cloneNode(true));
      x.addEventListener('click', (e) => { e.stopPropagation(); this.library.remove(t.id); });
      side.append(x);
    }
    li.append(title, meta, side);
    const play = () => this.on.play(t);
    li.addEventListener('click', play);
    li.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); play(); } });
    return li;
  }
}
