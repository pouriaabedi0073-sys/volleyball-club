How to optimize icons locally

This repo includes a small Node.js script that creates optimized WebP variants of heavy PNG icons.

Steps (Windows PowerShell):

1. Install dependencies (sharp):

```powershell
cd "C:\Users\20-pc\Desktop\project_fixed_finaly -101"
npm install
```

2. Run the optimizer:

```powershell
npm run optimize-icons
```

The script will create `-opt.webp` files next to the originals in the `icons/` folder. Review them and, if you want to replace the originals, you can rename them or delete originals and rename `*-opt.webp` files.

Notes:
- `sharp` requires a native build; on Windows this will download prebuilt binaries automatically.
- If you prefer a different quality/size, edit `tools/optimize-icons.js`.
