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
    input.addEventListener('change', () => { files = files.concat([...input.files]); input.value = ''; render(); });
    return {
      read: () => Promise.all(files.map(readFile)),
      count: () => files.length,
      clear: () => { urls.forEach((u) => URL.revokeObjectURL(u)); urls.clear(); files = []; render(); },
      render,
    };
  }

  /** 文章图库：显示已上传的素材图片，标注是否已用在正文里；点击把「图N」写进修改意见。 */
  function gallery(boxId, images, id, usedIds, target, coverId = '') {
    const box = document.getElementById(boxId);
    box.innerHTML = '';
    box.classList.toggle('hidden', !images.length);
    if (!images.length) return;
    const head = document.createElement('div');
    head.className = 'hint';
    head.textContent = '素材图片（点击把编号填进对话框，例如"图2放开头""图3做封面"）：';
    box.append(head);
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
      box.append(item);
    }
  }

  window.Mat = { picker, gallery };
})();
