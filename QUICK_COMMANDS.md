
ok first we need NODE!!!

Install w/ this (if you don't have nvm yet):
```
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
```

Reload shell, then we need to install node 22.22.2 (or any 22.x version):
```
nvm install 22.22.2
nvm alias default 22.22.2
nvm use 22.22.2
```

ORRR you can download from the webpage (nodejs.org) and install it manually.

check node version:
```
node -v
npm -v
```

THENNN we r going 2 install ev-sim w/ this:
```
curl -fsSL https://raw.githubusercontent.com/cornellev/ev-sim/main/install.sh | bash
```

on install marketspace click "y"

then open the dir, then run:
```
npm ci
```


then run:
```
npm run dev
```

then ur app should be running on localhost:3000 (amazing)