### Recipes

Below, there is some recipes for the most commom commands used in the api, like authentication, user creations, etc.

## User Creation

```curl
curl -H 'Content-type: application/json' 'http://localhost:3000/api/v1/auth/register' -d '{"name": "user", "email": "user@email.com", "password": "Fiap10203040"'}
```
