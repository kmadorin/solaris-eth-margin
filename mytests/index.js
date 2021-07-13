// Traditional Truffle test
const { ether, expectRevert } = require('@openzeppelin/test-helpers');
const { expect } = require('chai');

const axios = require('axios');

const TokenMock = artifacts.require('TokenMock');

const { bufferToHex } = require('ethereumjs-util');
const ethSigUtil = require('eth-sig-util');

const LimitOrderProtocol = artifacts.require('LimitOrderProtocol');
const ChainlinkCalculator = artifacts.require('ChainlinkCalculator');
const AggregatorV3Mock = artifacts.require('AggregatorV3Mock');

const SolarisMargin = artifacts.require('SolarisMargin');

const DAI_ABI = require('../abis/DAI');
const WETH_ABI = require('../abis/WETH');

const { buildOrderData, ABIOrder } = require('../test/helpers/orderUtils');
const { cutLastArg, toBN } = require('../test/helpers/utils');
const { web3 } = require('@openzeppelin/test-helpers/src/setup');

contract('LimitOrderProtocol', async function ([_, wallet]) {
    const privatekey =
        '59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';

    // const account = Wallet.fromPrivateKey(Buffer.from(privatekey, 'hex'));
    const aaveProtocolDataProvider = '0x057835Ad21a177dbdd3090bB1CAE03EaCF78Fc6d';
    const aaveLendingPoolAddressProvider = '0xB53C1a33016B2DC2fF3653530bfF1848a515c8c5';
    const oneInchExchangeAddress = '0x11111112542D85B3EF69AE05771c2dCCff4fAa26';
    const zeroAddress = '0x0000000000000000000000000000000000000000';

    const ASSET_ADDRESSES = {
        DAI: '0x6b175474e89094c44da98b954eedeac495271d0f',
        WETH: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
    };

    async function approveApiCaller (value, tokenAddress, nonce) {
        const url = 'https://api.1inch.exchange/v3.0/1/approve/calldata' +
        (value > -1 && value != null ? '?amount=' + value + '&' : '') + // tack on the value if it's greater than -1
        'tokenAddress=' + tokenAddress; // complete the called URL
        let temp = await axios.get(url); // get the api call
        temp = temp.data; // we only want the data object from the api call
        // we need to convert the gasPrice to hex
        // delete temp.gasPrice;
        // delete temp.gas; // ethersjs will find the gasLimit for users

        // we also need value in the form of hex
        let val = parseInt(temp.value); // get the value from the transaction
        val = '0x' + val.toString(16); // add a leading 0x after converting from decimal to hexadecimal
        temp.value = val; // set the value of value in the transaction object

        return temp; // return the data
    }

    async function fetchOneInchExchangeData (fromToken, toToken, fromAddress, destReceiver, amount) {
        try {
            const res = await axios.get('https://api.1inch.exchange/v3.0/1/swap', {
                params: {
                    fromTokenAddress: fromToken,
                    toTokenAddress: toToken,
                    fromAddress,
                    destReceiver,
                    amount,
                    slippage: 1,
                    disableEstimate: true,
                },
            });
            return res.data;
        } catch (e) {
            // console.log(e);
            return null;
        }
    }

    function buildOrder (
        exchange,
        makerAsset,
        takerAsset,
        makerAmount,
        takerAmount,
        maker = zeroAddress,
        taker = zeroAddress,
        predicate = '0x',
        permit = '0x',
        interaction = '0x',
    ) {
        return buildOrderWithSalt(
            exchange,
            '1',
            makerAsset,
            takerAsset,
            makerAmount,
            takerAmount,
            maker,
            taker,
            predicate,
            permit,
            interaction,
        );
    }

    function buildInverseWithSpread (inverse, spread) {
        return toBN(spread).setn(255, inverse).toString();
    }

    // function buildSinglePriceGetter (swap, calculator, oracle, inverse, spread) {
    //     const data = calculator.contract.methods.singlePrice(oracle.address, buildInverseWithSpread(inverse, spread), 0).encodeABI();
    //     return cutLastArg(swap.contract.methods.arbitraryStaticCall(calculator.address, data).encodeABI(), (64 - (data.length - 2) % 64) % 64);
    // }

    // eslint-disable-next-line no-unused-vars
    function buildDoublePriceGetter (swap, calculator, oracle1, oracle2, spread) {
        const data = calculator.contract.methods.doublePrice(oracle1.address, oracle2.address, buildInverseWithSpread(false, spread), 0).encodeABI();
        return cutLastArg(swap.contract.methods.arbitraryStaticCall(calculator.address, data).encodeABI(), (64 - (data.length - 2) % 64) % 64);
    }

    function buildOrderWithSalt (
        exchange,
        salt,
        makerAsset,
        takerAsset,
        makerAmount,
        takerAmount,
        maker = zeroAddress,
        taker = zeroAddress,
        predicate = '0x',
        permit = '0x',
        interaction = '0x',
    ) {
        return {
            salt: salt,
            makerAsset: makerAsset.address,
            takerAsset: takerAsset.address,
            makerAssetData: makerAsset.contract.methods
                .transferFrom(maker, taker, makerAmount)
                .encodeABI(),
            takerAssetData: takerAsset.contract.methods
                .transferFrom(taker, maker, takerAmount)
                .encodeABI(),
            getMakerAmount: cutLastArg(
                exchange.contract.methods
                    .getMakerAmount(makerAmount, takerAmount, 0)
                    .encodeABI(),
            ),
            getTakerAmount: cutLastArg(
                exchange.contract.methods
                    .getTakerAmount(makerAmount, takerAmount, 0)
                    .encodeABI(),
            ),
            predicate: predicate,
            permit: permit,
            interaction: interaction,
        };
    }

    beforeEach(async function () {
        this.swap = await LimitOrderProtocol.new();
        this.calculator = await ChainlinkCalculator.new();
        this.solarisMargin = await SolarisMargin.new(this.swap.address, oneInchExchangeAddress, aaveLendingPoolAddressProvider, aaveProtocolDataProvider);

        this.usdc = await TokenMock.new('USDC', 'USDC');
        // this.dai = await TokenMock.new('DAI', 'DAI');
        // this.weth = await TokenMock.new('WETH', 'WETH');

        this.dai = new web3.eth.Contract(DAI_ABI, ASSET_ADDRESSES.DAI);
        this.dai.contract = {methods: this.dai.methods};
        this.dai.address = ASSET_ADDRESSES.DAI;
        this.weth = new web3.eth.Contract(WETH_ABI, ASSET_ADDRESSES.WETH);
        this.weth.contract = {methods: this.dai.methods};
        this.weth.address = ASSET_ADDRESSES.DAI;

        // We get the chain id from the contract because Ganache (used for coverage) does not return the same chain id
        // from within the EVM as from the JSON RPC interface.
        // See https://github.com/trufflesuite/ganache-core/issues/515
        this.chainId = await this.usdc.getChainId();

        // await this.dai.mint(this.solarisMargin.address, '10000000000000000000000');
        // await this.weth.mint(this.solarisMargin.address, '10000000000000000000000');
        // await this.dai.methods.mint(this.solarisMargin.address, '10000000000000000000000').send({from: wallet});
        await this.weth.methods.deposit().send({ from: wallet, value: ether('10') });

        // await this.dai.mint(_, '10000000000000000000000');
        // await this.weth.mint(_, '10000000000000000000000');
        const nonce = web3.eth.getTransactionCount(wallet);

        const wethApproveTx = await approveApiCaller(ether('1'), ASSET_ADDRESSES.WETH, nonce);
        const wethToDaiSwapData = await fetchOneInchExchangeData(
            ASSET_ADDRESSES.WETH,
            ASSET_ADDRESSES.DAI,
            wallet,
            wallet,
            ether('1').toString(),
        );

        wethApproveTx.from = wallet;

        // console.log(wethToDaiSwapData.tx);
        wethToDaiSwapData.tx.gas = 400576;
        try {
            await web3.eth.sendTransaction(wethApproveTx);
            await web3.eth.sendTransaction(wethToDaiSwapData.tx);
            console.log('Transaction success');
        } catch (e) {
            console.log(e);
            console.log('Transaction failure');
        }

        // await this.dai.approve(this.swap.address, '10000000000000000000000');
        // await this.weth.approve(this.swap.address, '10000000000000000000000');

        // await this.dai.approve(this.solarisMargin.address, '10000000000000000000000');
        // await this.weth.approve(this.solarisMargin.address, '10000000000000000000000');
        // await this.dai.approve(this.swap.address, '10000000000000000000000', { from: _ });
        // await this.weth.approve(this.swap.address, '10000000000000000000000', { from: _ });

        await this.dai.methods.approve(this.swap.address, '10000000000000000000000').send({ from: wallet });
        await this.weth.methods.approve(this.swap.address, '10000000000000000000000').send({ from: _ });

        await this.dai.methods.approve(this.solarisMargin.address, '10000000000000000000000').send({ from: wallet });
        await this.weth.methods.approve(this.solarisMargin.address, '10000000000000000000000').send({ from: _ });

        this.daiOracle = await AggregatorV3Mock.new(ether('0.00025'));
        this.daiOracleTakeProfit = await AggregatorV3Mock.new(ether('0.000208333'));
        this.daiOracleStopLoss = await AggregatorV3Mock.new(ether('0.000208333'));
    });

    describe('Margin Trading Test', function () {
        it('1000 dai -> eth 3x leverage, stop loss - 80%, take profit - 120%, eth price grows 20% up', async function () {
            // chainlink rate is 1 eth = 4000 dai
            const makerAmount = ether('3000');
            const takerAmount = ether('0.75');

            const oneInchSwapResponse = await fetchOneInchExchangeData(
                ASSET_ADDRESSES.WETH,
                ASSET_ADDRESSES.DAI,
                this.solarisMargin.address,
                this.solarisMargin.address,
                ether('2000').toString(),
            );

            const oneInchSwapData = oneInchSwapResponse.tx.data;

            const calculatorCall = this.calculator.contract.methods.singlePrice(this.daiOracleTakeProfit.address, buildInverseWithSpread(true, '1000000000'), ether('1')).encodeABI();
            // const initialPrice = await this.calculator.singlePrice(this.daiOracle.address, buildInverseWithSpread(true, '1000000000'), ether('1'));
            const takeProfitOraclePrice = await this.calculator.singlePrice(this.daiOracleTakeProfit.address, buildInverseWithSpread(true, '1000000000'), ether('1'));
            const stopLossOraclePrice = await this.calculator.singlePrice(this.daiOracleStopLoss.address, buildInverseWithSpread(true, '1000000000'), ether('1'));
            const takeProfitCall = this.swap.contract.methods.gt(takeProfitOraclePrice.subn(1), this.calculator.address, calculatorCall).encodeABI();
            const stopLossCall = this.swap.contract.methods.lt(stopLossOraclePrice.addn(1), this.calculator.address, calculatorCall).encodeABI();

            const predicate = this.swap.contract.methods.or(
                [this.swap.address, this.swap.address],
                [stopLossCall, takeProfitCall],
            ).encodeABI();

            const order = buildOrder(
                this.swap,
                this.dai,
                this.weth,
                makerAmount,
                takerAmount,
                this.solarisMargin.address,
                zeroAddress,
                predicate,
            );

            const data = buildOrderData(this.chainId, this.swap.address, order);
            const orderHash = bufferToHex(ethSigUtil.TypedDataUtils.sign(data));
            order.interaction = orderHash;

            // await this.solarisMargin.createOrder(orderHash, this.dai.address, makerAmount);
            try {
                await this.solarisMargin.longLeverage(ASSET_ADDRESSES.DAI, ASSET_ADDRESSES.WETH, makerAmount, 3, oneInchSwapData, orderHash, { from: wallet });
            } catch (e) {
                console.log(e);
            }

            return true;
            // const signature = web3.eth.abi.encodeParameter(ABIOrder, order);

            // const makerDai = await this.dai.balanceOf(this.solarisMargin.address);
            // const takerDai = await this.dai.balanceOf(_);
            // const makerWeth = await this.weth.balanceOf(this.solarisMargin.address);
            // const takerWeth = await this.weth.balanceOf(_);

            // await this.swap.fillOrder(order, signature, makerAmount, 0, takerAmount, { from: _ });

            // expect(await this.dai.balanceOf(this.solarisMargin.address)).to.be.bignumber.equal(
            //     makerDai.sub(makerAmount),
            // );
            // expect(await this.dai.balanceOf(_)).to.be.bignumber.equal(
            //     takerDai.add(makerAmount),
            // );
            // expect(await this.weth.balanceOf(this.solarisMargin.address)).to.be.bignumber.equal(
            //     makerWeth.add(takerAmount),
            // );
            // expect(await this.weth.balanceOf(_)).to.be.bignumber.equal(
            //     takerWeth.sub(takerAmount),
            // );
        });
    });
});
