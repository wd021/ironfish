{
  "targets": [
    {
      "target_name": "addon",
      "sources": [ "translation.cpp",'/home/hentai8-desktop/Desktop/project/blake3-miner-cuda-to-nodejs/blake3-miner.o'],
    'conditions': [
        [ 'OS=="linux"', {
          'libraries': ['-lcuda','-lcudart'],
          'library_dirs': ['/usr/local/cuda/lib64']
        }]
    ],
    "include_dirs": [
         "<!(node -e \"require('nan')\")"
      ],
      'defines': [ 'NAPI_DISABLE_CPP_EXCEPTIONS' ],
    }
  ]
}