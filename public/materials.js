// 素材选择与图片图库：选中的文件以缩略图/标签列出（图片按 图1、图2… 编号，可移除）；
// 文章图库显示已上传图片，点击把「图N」插入修改意见框。
(() => {
  const IMG = /\.(png|jpe?g|gif|webp)$/i;
  const fmtSize = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)}MB` : `${Math.ceil(n / 1024)}KB`);

  function readFile(f) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve({ name: f.name, content: String(r.result).split(',')[1] || '' });
      r.onerror = reject;
      r.readAsDataURL(f);
    });
  }

  /** 绑定一个 <input type=file> 和列表容器；可多次追加选择。startNo() 返回图片起始编号。 */
  function picker(inputId, listId, startNo = () => 1) {
    const input = document.getElementById(inputId);
    const list = document.getElementById(listId);
    let files = [];
    const urls = new Map();
    function render() {
      list.innerHTML = '';
      let n = startNo();
      files.forEach((f, i) => {
        const item = document.createElement('div');
        item.className = 'mat-item';
        const isImg = IMG.test(f.name);
        if (isImg) {
          if (!urls.has(f)) urls.set(f, URL.createObjectURL(f));
          const img = document.createElement('img');
          img.src = urls.get(f);
          item.append(img);
        } else {
          const ext = document.createElement('div');
          ext.className = 'mat-ext';
          ext.textContent = (f.name.split('.').pop() || '').toUpperCase();
          item.append(ext);
        }
        const label = document.createElement('div');
        label.className = 'mat-label';
        label.textContent = `${isImg ? `图${n++} · ` : ''}${f.name} (${fmtSize(f.size)})`;
        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'mat-del';
        del.textContent = '×';
        del.title = '移除';
        del.onclick = () => { URL.revokeObjectURL(urls.get(f)); urls.delete(f); files.splice(i, 1); render(); };
        item.append(label, del);
        list.append(item);
      });
    }
    const add = (list) => { files = files.concat([...list]); render(); };
    input.addEventListener('change', () => { add(input.files); input.value = ''; });
    return {
      add,
      read: () => Promise.all(files.map(readFile)),
      count: () => files.length,
      clear: () => { urls.forEach((u) => URL.revokeObjectURL(u)); urls.clear(); files = []; render(); },
      render,
    };
  }

  /** 剪贴板/拖拽里的文件；截图粘贴时文件名都是 image.png，改成带时间的名字以免重名。 */
  function filesFrom(dt) {
    const out = [...(dt?.files || [])];
    if (!out.length) for (const it of dt?.items || []) if (it.kind === 'file') { const f = it.getAsFile(); if (f) out.push(f); }
    const stamp = new Date().toTimeString().slice(0, 8).replace(/:/g, '');
    return out.map((f, i) => (/^image\.(png|jpe?g|gif|webp)$/i.test(f.name) || !f.name
      ? new File([f], `粘贴-${stamp}-${i + 1}.${(f.type.split('/')[1] || 'png').replace('jpeg', 'jpg')}`, { type: f.type })
      : f));
  }

  /** 让输入框支持直接粘贴、拖入图片/文档（文字照常粘贴）。 */
  function acceptDrops(el, pick) {
    el.addEventListener('paste', (e) => {
      const fs = filesFrom(e.clipboardData);
      if (!fs.length) return;
      pick.add(fs);
      if (!e.clipboardData.getData('text/plain')) e.preventDefault(); // 纯图片不往框里塞文字
    });
    el.addEventListener('dragover', (e) => { if ([...(e.dataTransfer?.types || [])].includes('Files')) { e.preventDefault(); el.classList.add('drop'); } });
    el.addEventListener('dragleave', () => el.classList.remove('drop'));
    el.addEventListener('drop', (e) => {
      el.classList.remove('drop');
      const fs = filesFrom(e.dataTransfer);
      if (fs.length) { e.preventDefault(); pick.add(fs); }
    });
  }

  /** 文章图库：显示已上传的素材图片，标注是否已用在正文里；点击把「图N」写进修改意见。 */
  function gallery(boxId, images, id, usedIds, target, coverId = '') {
    const box = document.getElementById(boxId);
    box.innerHTML = '';
    box.classList.toggle('hidden', !images.length);
    if (!images.length) return;
    const head = document.createElement('div');
    head.className = 'g-head';
    const tip = document.createElement('span');
    tip.textContent = `素材图片 ${images.length} 张 · 点图把编号填进对话框（如"图2放开头""图3做封面"）`;
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'ghost';
    const sync = () => { toggle.textContent = box.classList.contains('open') ? '收起' : '展开全部'; };
    box.classList.toggle('open', localStorage.getItem('wx.galleryOpen') === '1');
    toggle.onclick = () => { box.classList.toggle('open'); localStorage.setItem('wx.galleryOpen', box.classList.contains('open') ? '1' : '0'); sync(); };
    sync();
    head.append(tip, toggle);
    const strip = document.createElement('div');
    strip.className = 'g-strip';
    box.append(head, strip);
    for (const m of images) {
      const item = document.createElement('div');
      item.className = `mat-item gallery${usedIds.includes(m.id) ? ' used' : ''}`;
      const img = document.createElement('img');
      img.src = `/media/${id}/${m.src.replace('images/', '')}`;
      const label = document.createElement('div');
      label.className = 'mat-label';
      label.textContent = `${m.id}${usedIds.includes(m.id) ? ' · 已用' : ' · 未用'}${m.id === coverId ? ' · 封面' : ''}`;
      item.title = m.from;
      item.append(img, label);
      item.onclick = () => { const t = document.getElementById(target); t.value += (t.value ? '，' : '') + m.id; t.focus(); };
      strip.append(item);
    }
  }

  window.Mat = { picker, gallery, acceptDrops };
})();
