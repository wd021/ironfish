{
  "targets": [
    {
      "target_name": "addon",
      "sources": [ "translation.cpp",'/root/ironfish-wd021/ironfish-gpu-mining/blake3-miner.o'],
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