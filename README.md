# Vitrine de iPhones

Site com **vitrine pública** (`/`) e **painel admin** (`/admin.html`, protegido por senha).
Produtos e configurações ficam em um banco **SQLite**; as fotos ficam em disco.
Cada card tem o botão "Tenho interesse", que abre o WhatsApp com uma mensagem pronta sobre o produto.

## Rodar localmente
```bash
npm install
ADMIN_PASSWORD=minha-senha SESSION_SECRET=frase-longa-aleatoria npm start
```
Vitrine: http://localhost:3000 — Admin: http://localhost:3000/admin.html

No admin: informe seu WhatsApp (DDI+DDD, ex: 5511999999999), cadastre os produtos e envie o link da vitrine aos clientes.

## Variáveis de ambiente
| Variável | Para que serve |
|---|---|
| `ADMIN_PASSWORD` | Senha do painel (**obrigatório trocar**) |
| `SESSION_SECRET` | Segredo que assina o login (mantém você logado entre reinícios) |
| `PORT` | Porta (padrão 3000) |
| `DATA_DIR` | Pasta do banco e das fotos (padrão `./data`) |

## Hospedar
Precisa de Node 18+ e de uma **pasta persistente** em `DATA_DIR`, senão você perde produtos e fotos a cada deploy.
- **VPS** (Hostinger, DigitalOcean, Contabo...): `npm install && npm start`, com `pm2` e Nginx + HTTPS.
- **Railway / Render / Fly.io**: use o `Dockerfile` incluso e crie um volume do próprio painel montado em `/data`.
- Use sempre HTTPS (os hosts acima já fornecem). Com `NODE_ENV=production` o cookie de login vira `Secure`.

## Backup
Copie a pasta `DATA_DIR` (contém `vitrine.db` e `uploads/`).
