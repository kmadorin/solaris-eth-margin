require('@nomiclabs/hardhat-truffle5');
require('solidity-coverage');
require('hardhat-deploy');
require('hardhat-gas-reporter');

module.exports = {
    solidity: {
        version: '0.8.4',
        settings: {
            optimizer: {
                enabled: true,
                runs: 1000000,
            },
        },
    },
    gasReporter: {
        enable: true,
        currency: 'USD',
    },
    chainId: 1,
    networks: {
        localhost: {
            chainId: 1,
            url: 'http://localhost:8545',
            /*
              notice no mnemonic here? it will just use account 0 of the hardhat node to deploy
              (you can put in a mnemonic here to set the deployer locally)
            */
        },
        hardhat: {
            forking: {
                url: 'https://mainnet.infura.io/v3/e74fddc191a0443bb0af79c5b7da6251',
                allowUnlimitedContractSize: true,
            },
        },
    },
    paths: {
        tests: './mytests',
        sources: './contracts',
        artifacts: './artifacts',
    },
};
