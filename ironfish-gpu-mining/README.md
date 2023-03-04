# blake3-miner-cuda-to-nodejs
blake3 miner code by nan
cuda to nodejs

* **nvcc** must be installed. Check it using **nvcc —version**
*  g++/cc to be installed.
*  npm and node version 8.x +
* **nan v8** is needed which can be installed by npm.

## Make sure to make it run we need to update the following directory as it may be machine specific :

 ```"sources": [ "main.cpp",'/content/node-js-cuda/blake3-miner.o'],```
 
 ## And
 ```'library_dirs': [ '/usr/local/cuda/lib64']```
 in the **binding.gyp**

```
npm install --unsafe-perm
nvcc -c  blake3-miner.cu --compiler-options -fPIC
node index.js
   ```