### Recipes

Below, there is some recipes for the most commom commands used in the api, like authentication, user creations, etc.

## User Creation

```curl
curl -H 'Content-type: application/json' 'http://localhost:3000/api/v1/auth/register' -d '{"name": "user", "email": "user@email.com", "password": "Fiap10203040"'}
```

### Healthcheck

```curl
curl -H 'Content-type: application/json' 'http://localhost:3000/health'
```

### Tokens

## Create a new token / refresh token / Login

```curl
curl -X POST -H "Content-type: application/json" 'http://localhost:3000/api/v1/auth/login' -d '{"email": "user@email.com", "password": "Fiap10203040"'}
```

## Verify if token is active / login data

```curl
curl -H 'Content-type: application/json' -H 'Authorization: Bearer TOKEN (passo anterior)' 'http://localhost:3000/api/v1/me'
```

## Renew token

```curl
curl -H 'Content-type: application/json' -d '{"refreshToken": "<REFRESHTOKEN>"}' 'http://localhost:3000/api/v1/auth/refresh' -vvv
```

## logout

```curl
curl -H 'Content-type: application/json' -H 'Authorization: TOKEN' -d '{"refreshToken": "<REFRESHTOKEN>"}' 'http://localhost:3000/api/v1/auth/refresh' -vvv
```
