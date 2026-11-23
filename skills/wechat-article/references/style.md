# 公众号排版内联样式（直接复制使用）

主色 `#07c160`（微信绿）。如 brief.extra 指定了主色，把下面所有 `#07c160` 换成指定色。

## 外层容器（整篇正文包一层）

```html
<section style="font-size:16px;line-height:1.8;color:#333;letter-spacing:0.5px;text-align:justify;">
  ……正文……
</section>
```

## 段落

```html
<p style="margin:0 0 16px;">段落文字，<strong style="color:#07c160;">关键结论加粗</strong>。</p>
```

## 小标题（h2）

```html
<h2 style="font-size:18px;font-weight:bold;color:#222;margin:32px 0 16px;padding-left:10px;border-left:4px solid #07c160;line-height:1.4;">一、小标题</h2>
```

## 三级标题（h3）

```html
<h3 style="font-size:16px;font-weight:bold;color:#07c160;margin:24px 0 12px;">小点标题</h3>
```

## 引用 / 金句

```html
<blockquote style="margin:20px 0;padding:12px 16px;background:#f6f8f7;border-left:3px solid #07c160;color:#555;font-size:15px;">金句或引用原话。——出处</blockquote>
```

## 列表

```html
<ul style="margin:0 0 16px;padding-left:22px;">
  <li style="margin-bottom:8px;">要点一</li>
</ul>
```

## 分隔线

```html
<hr style="border:none;border-top:1px dashed #ddd;margin:28px 0;">
```

## 图片（素材图片，src 照抄 images.json）

```html
<p style="margin:20px 0 6px;text-align:center;"><img src="images/img01.jpg" alt="图1 图注" style="max-width:100%;border-radius:6px;"></p>
<p style="margin:0 0 20px;text-align:center;font-size:13px;color:#999;">图注：一句话说明画面</p>
```

小图：把 `max-width:100%` 改为 `max-width:60%`。

## 配图建议占位

```html
<p style="margin:16px 0;padding:10px;background:#fafafa;color:#999;font-size:14px;text-align:center;">【配图建议：成都街头的苍蝇馆子，热气腾腾的锅魁】</p>
```

## 结尾互动

```html
<p style="margin:28px 0 0;padding:14px 16px;background:#f0faf4;border-radius:6px;color:#333;font-size:15px;">你怎么看？欢迎在评论区聊聊。</p>
```
