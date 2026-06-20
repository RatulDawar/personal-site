import { defineConfig } from 'astro/config';

function rehypeTableWrap() {
  return (tree) => {
    const visit = (node) => {
      if (!node.children) return;
      for (let i = 0; i < node.children.length; i++) {
        const child = node.children[i];
        if (child.type === 'element' && child.tagName === 'table') {
          node.children[i] = {
            type: 'element',
            tagName: 'div',
            properties: { className: ['table-wrap'] },
            children: [child],
          };
        } else {
          visit(child);
        }
      }
    };
    visit(tree);
  };
}

export default defineConfig({
  site: 'https://personal-site-ratuldawar.vercel.app',
  markdown: {
    rehypePlugins: [rehypeTableWrap],
  },
});
